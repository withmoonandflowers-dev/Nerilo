/**
 * ADR-0023 P1 複本持久化：跨 handler instance 的核心保證
 * - reserve-then-send：重建 handler 後 seq 續增、永不重用（碰撞根源根治）
 * - hydrate：紀錄/floors 從複本重生 → 去重仍有效、digest 能補別人
 * - 持久層故障：優雅退回記憶體模式，不炸
 *
 * 用記憶體假持久層（同一份 Map 傳給兩個 instance = 模擬重載後同一顆 IndexedDB）。
 */
import { describe, it, expect, vi } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import type { IGossipPersistence } from '../../src/core/mesh/GossipPersistence';
import type { GossipMessage } from '../../src/types';

// ── 記憶體假持久層 ──────────────────────────────────────────────────────────
function makeFakePersistence(): IGossipPersistence & {
  dump(): Map<string, GossipMessage>;
} {
  const records = new Map<string, GossipMessage>(); // key: room|sender|seq
  const meta = new Map<string, { floor?: number; nextSeq?: number }>(); // key: room|sender
  return {
    async reserveSeq(roomId, senderId) {
      const k = `${roomId}|${senderId}`;
      const m = meta.get(k) ?? {};
      const seq = m.nextSeq ?? 1;
      meta.set(k, { ...m, nextSeq: seq + 1 });
      return seq;
    },
    async loadRoom(roomId) {
      const out: GossipMessage[] = [];
      for (const [k, v] of records) if (k.startsWith(`${roomId}|`)) out.push(v);
      const floors: Array<{ senderId: string; floor: number }> = [];
      for (const [k, m] of meta) {
        if (k.startsWith(`${roomId}|`) && typeof m.floor === 'number') {
          floors.push({ senderId: k.split('|')[1]!, floor: m.floor });
        }
      }
      return { records: out, floors };
    },
    async saveRecord(roomId, message) {
      records.set(`${roomId}|${message.senderId}|${message.seq}`, message);
    },
    async evictRecord(roomId, senderId, seq, newFloor) {
      records.delete(`${roomId}|${senderId}|${seq}`);
      const k = `${roomId}|${senderId}`;
      const m = meta.get(k) ?? {};
      meta.set(k, { ...m, floor: Math.max(m.floor ?? 0, newFloor) });
    },
    dump: () => records,
  };
}

// ── mocks（同 GossipMessageHandler.spec 款式）───────────────────────────────
function makeMocks() {
  const neighbor = {
    getId: vi.fn().mockReturnValue('n1'),
    getState: vi.fn().mockReturnValue('connected'),
    send: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
  };
  return {
    neighbor,
    topology: {
      getNeighbors: vi.fn().mockReturnValue([neighbor]),
      getGossipConfig: vi.fn().mockReturnValue({ fanout: 2, ttl: 8 }),
    },
    identity: {
      exportPublicKey: vi.fn().mockResolvedValue('pk'),
      getPrivateKey: vi.fn().mockReturnValue({} as CryptoKey),
      deriveUserId: vi.fn().mockResolvedValue('remote-sender'),
    },
    security: {
      signMessage: vi.fn().mockResolvedValue('sig'),
      importPublicKey: vi.fn().mockResolvedValue({} as CryptoKey),
      verifyMessage: vi.fn().mockResolvedValue(true),
    },
  };
}

function makeHandler(persistence: IGossipPersistence | null, m = makeMocks()) {
  return {
    handler: new GossipMessageHandler(
      'room-r', 'local-u',
      m.identity as never, m.security as never, m.topology as never,
      null, persistence
    ),
    mocks: m,
  };
}

function remoteMsg(seq: number, content = `m${seq}`): GossipMessage {
  return {
    roomId: 'room-r', senderId: 'remote-sender', pubKey: 'pk',
    seq, timestamp: Date.now(), content, ttl: 1, signature: 'sig',
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ADR-0023 P1 複本持久化', () => {
  it('重建 handler 後自己的 seq 續增，永不重用', async () => {
    const p = makeFakePersistence();

    const a = makeHandler(p);
    await a.handler.hydrate();
    await a.handler.sendMessage('one');
    await a.handler.sendMessage('two');
    const sentA = a.mocks.neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
    expect(sentA).toEqual([1, 2]);

    // 模擬離開再進：全新 instance，同一顆持久層
    const b = makeHandler(p);
    await b.handler.hydrate();
    await b.handler.sendMessage('three');
    const sentB = b.mocks.neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
    expect(sentB).toEqual([3]); // 舊實作這裡會是 1 → 被對方當重複丟棄
  });

  it('hydrate 重生複本：舊紀錄去重仍有效、digest 能補給缺的人', async () => {
    const p = makeFakePersistence();

    const a = makeHandler(p);
    await a.handler.hydrate();
    const seen: string[] = [];
    a.handler.onMessage((m) => seen.push(m.content));
    await a.handler.handleReceivedMessage(remoteMsg(1, 'hello'), 'n1');
    await tick(); // 等 saveRecord 落地
    expect(seen).toEqual(['hello']);

    // 重建：同一則再送來 → 必須被複本去重（不重複顯示）
    const b = makeHandler(p);
    await b.handler.hydrate();
    const seenB: string[] = [];
    b.handler.onMessage((m) => seenB.push(m.content));
    await b.handler.handleReceivedMessage(remoteMsg(1, 'hello'), 'n1');
    expect(seenB).toEqual([]); // 已在複本 → 去重

    // 且能把複本裡的紀錄補給宣告缺件的 peer
    const neighbor = b.mocks.neighbor;
    await b.handler.handleDigest({}, neighbor as never);
    const filled = neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
    expect(filled).toContain(1);
  });

  it('自己送出的紀錄也落複本，重建後可補他人', async () => {
    const p = makeFakePersistence();
    const a = makeHandler(p);
    await a.handler.hydrate();
    await a.handler.sendMessage('mine');
    await tick();

    const b = makeHandler(p);
    await b.handler.hydrate();
    await b.handler.handleDigest({}, b.mocks.neighbor as never);
    const filled = b.mocks.neighbor.send.mock.calls.map((c) => c[0] as GossipMessage);
    expect(filled.some((m) => m.senderId === 'local-u' && m.content === 'mine')).toBe(true);
  });

  it('持久層故障：hydrate/reserve 都優雅退回記憶體模式', async () => {
    const broken: IGossipPersistence = {
      reserveSeq: vi.fn().mockRejectedValue(new Error('boom')),
      loadRoom: vi.fn().mockRejectedValue(new Error('boom')),
      saveRecord: vi.fn().mockRejectedValue(new Error('boom')),
      evictRecord: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const a = makeHandler(broken);
    await expect(a.handler.hydrate()).resolves.toBeUndefined(); // 不炸
    await a.handler.sendMessage('still-works'); // reserve 失敗 → 記憶體 seq
    const sent = a.mocks.neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
    expect(sent).toEqual([1]);
  });
});
