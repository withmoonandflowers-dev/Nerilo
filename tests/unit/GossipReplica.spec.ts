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
  const records = new Map<string, GossipMessage>(); // key: room|sender|epoch|seq
  const meta = new Map<string, {
    floor?: number; floorEpoch?: number; nextSeq?: number;
    nextSessionEpoch?: number; acceptedEpoch?: number;
  }>(); // key: room|sender
  return {
    async reserveSeq(roomId, senderId) {
      const k = `${roomId}|${senderId}`;
      const m = meta.get(k) ?? {};
      const seq = m.nextSeq ?? 1;
      meta.set(k, { ...m, nextSeq: seq + 1 });
      await new Promise((r) => setTimeout(r, 0)); // 模擬 IDB 非同步（暴露共享欄位競態）
      return seq;
    },
    async reserveSessionEpoch(roomId, senderId) {
      const k = `${roomId}|${senderId}`;
      const m = meta.get(k) ?? {};
      const reserved = Math.max(m.nextSessionEpoch ?? 1, Date.now());
      meta.set(k, { ...m, nextSessionEpoch: reserved + 1 });
      return reserved;
    },
    async saveAcceptedEpoch(roomId, senderId, epoch) {
      const k = `${roomId}|${senderId}`;
      const m = meta.get(k) ?? {};
      if ((m.acceptedEpoch ?? 0) < epoch) meta.set(k, { ...m, acceptedEpoch: epoch });
    },
    async loadRoom(roomId) {
      const out: GossipMessage[] = [];
      for (const [k, v] of records) if (k.startsWith(`${roomId}|`)) out.push(v);
      const floors: Array<{ senderId: string; epoch: number; floor: number }> = [];
      const acceptedEpochs: Array<{ senderId: string; epoch: number }> = [];
      for (const [k, m] of meta) {
        if (!k.startsWith(`${roomId}|`)) continue;
        const senderId = k.split('|')[1]!;
        if (typeof m.floor === 'number') {
          floors.push({ senderId, epoch: m.floorEpoch ?? 0, floor: m.floor });
        }
        if (typeof m.acceptedEpoch === 'number') {
          acceptedEpochs.push({ senderId, epoch: m.acceptedEpoch });
        }
      }
      return { records: out, floors, acceptedEpochs };
    },
    async saveRecord(roomId, message) {
      records.set(`${roomId}|${message.senderId}|${message.sessionEpoch}|${message.seq}`, message);
    },
    async evictRecord(roomId, senderId, sessionEpoch, seq, newFloor) {
      records.delete(`${roomId}|${senderId}|${sessionEpoch}|${seq}`);
      const k = `${roomId}|${senderId}`;
      const m = meta.get(k) ?? {};
      if (sessionEpoch > (m.floorEpoch ?? -1)) {
        meta.set(k, { ...m, floorEpoch: sessionEpoch, floor: newFloor });
      } else if (sessionEpoch === (m.floorEpoch ?? -1)) {
        meta.set(k, { ...m, floor: Math.max(m.floor ?? 0, newFloor) });
      }
    },
    async listRooms() {
      const rooms = new Set<string>();
      for (const k of records.keys()) rooms.add(k.split('|')[0]!);
      return [...rooms];
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

function remoteMsg(seq: number, content = `m${seq}`, sessionEpoch = 1): GossipMessage {
  return {
    roomId: 'room-r', senderId: 'remote-sender', pubKey: 'pk',
    seq, sessionEpoch, timestamp: Date.now(), content, ttl: 1, signature: 'sig',
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

  it('Spec 009：acceptedEpoch 落盤 → 重載後立即拒舊代重放（無首接觸窗）', async () => {
    const p = makeFakePersistence();
    const a = makeHandler(p);
    await a.handler.hydrate();
    await a.handler.handleReceivedMessage(remoteMsg(1, 'current', 9), 'n1');
    await tick(); // 等 saveAcceptedEpoch 落地

    // 重載：同一顆持久層，全新 instance
    const b = makeHandler(p);
    await b.handler.hydrate();
    const seenB: string[] = [];
    b.handler.onMessage((m) => seenB.push(m.content));
    // 舊會話（epoch 3）重放：即使 (epoch, seq) 不在複本，也因現行代門檻直接拒收
    await b.handler.handleReceivedMessage(remoteMsg(99, 'replayed', 3), 'n1');
    expect(seenB).toEqual([]);
    // 現行代訊息照常接受
    await b.handler.handleReceivedMessage(remoteMsg(2, 'fresh', 9), 'n1');
    expect(seenB).toEqual(['fresh']);
  });

  it('Spec 009：重載後新會話代嚴格高於前會話（reserveSessionEpoch 單調）', async () => {
    const p = makeFakePersistence();
    const a = makeHandler(p);
    await a.handler.hydrate();
    await a.handler.sendMessage('s1');
    const epochA = (a.mocks.neighbor.send.mock.calls[0][0] as GossipMessage).sessionEpoch;

    const b = makeHandler(p);
    await b.handler.hydrate();
    await b.handler.sendMessage('s2');
    const epochB = (b.mocks.neighbor.send.mock.calls[0][0] as GossipMessage).sessionEpoch;
    expect(epochB).toBeGreaterThan(epochA);
  });

  it('並發送出不共享 seq：chat 與 read 同時送，兩則都入 store、seq 各自獨立', async () => {
    // 回歸（四線合併時實測根因）：sendMessage 把保留到的 seq 寫回共享欄位 this.seq，
    // 再經過多個 await 後才組訊息——並發的第二個 send 會覆寫欄位，兩則訊息拿到同一個
    // seq，第二筆 storePut 被去重靜默丟棄 → 寄件端自己把訊息弄丟（收端永遠收不到）。
    // 頁面上的實際觸發：使用者送 chat 的同時 advanceMyRead 以 fire-and-forget 送 read。
    const p = makeFakePersistence();
    const a = makeHandler(p);
    await a.handler.hydrate();

    await Promise.all([
      a.handler.sendMessage('chat-msg', 'id-chat', 'chat'),
      a.handler.sendMessage('{"watermark":"w"}', undefined, 'read'),
    ]);

    const sent = a.mocks.neighbor.send.mock.calls.map((c) => c[0] as GossipMessage);
    expect(sent).toHaveLength(2);
    const seqs = sent.map((m) => m.seq).sort();
    expect(seqs).toEqual([1, 2]); // 兩則各自的 seq，不得共享

    // 兩則都必須在 store（digest 對空 digest 的補送應含兩筆）
    const probe = a.mocks.neighbor;
    probe.send.mockClear();
    await a.handler.handleDigest({}, probe as never);
    expect(probe.send.mock.calls.length).toBe(2);
  });

  it('持久層故障：hydrate/reserve 都優雅退回記憶體模式', async () => {
    const broken: IGossipPersistence = {
      reserveSeq: vi.fn().mockRejectedValue(new Error('boom')),
      reserveSessionEpoch: vi.fn().mockRejectedValue(new Error('boom')),
      saveAcceptedEpoch: vi.fn().mockRejectedValue(new Error('boom')),
      loadRoom: vi.fn().mockRejectedValue(new Error('boom')),
      saveRecord: vi.fn().mockRejectedValue(new Error('boom')),
      evictRecord: vi.fn().mockRejectedValue(new Error('boom')),
      listRooms: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const a = makeHandler(broken);
    await expect(a.handler.hydrate()).resolves.toBeUndefined(); // 不炸
    await a.handler.sendMessage('still-works'); // reserve 失敗 → 記憶體 seq
    const sent = a.mocks.neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
    expect(sent).toEqual([1]);
  });
});
