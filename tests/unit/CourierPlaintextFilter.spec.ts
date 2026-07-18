/**
 * Spec 012 P3 conformance：盲信使代管資格規則（protocol 軌）。
 *
 * 規則：紀錄合格 iff（channel==='keyx' 且 content 為合法 keyx1）或（content 為合法 nrec1 信封）。
 * 推側（runCourierBackup／reconcile push）與收側（CourierStore.deposit／hydrate）皆執行。
 * 明文紀錄的補齊路徑只有成員間 anti-entropy；信使不代管（ADR-0023 修訂二硬前提）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { isCourierEligibleRecord, filterCourierEligible } from '../../src/core/relay/courierEligibility';
import { CourierStore, DEFAULT_COURIER_CONFIG } from '../../src/core/relay/CourierStore';
import {
  CourierServer,
  CourierClient,
  buildRoomStore,
  runCourierBackup,
  type CourierBus,
  type CourierBackupDeps,
} from '../../src/core/relay/CourierService';
import { enc, keyxContent } from './_courierFixtures';
import type { GossipMessage, P2PEnvelope } from '../../src/types';
import { maxEpochs } from '../../src/core/mesh/antiEntropy';

function rec(over: Partial<GossipMessage> = {}): GossipMessage {
  return {
    roomId: 'r1', senderId: 's1', pubKey: 'pk', seq: 1, sessionEpoch: 1, timestamp: 1000,
    content: enc('x'), ttl: 3, signature: 'SIG', ...over,
  };
}

/** 對接 bus（同 CourierService.spec 的 LinkedBus 形狀） */
class BusEnd implements CourierBus {
  private handlers = new Map<string, Set<(env: P2PEnvelope) => void | Promise<void>>>();
  partner!: BusEnd;
  subscribe(ns: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }
  async send(env: P2PEnvelope): Promise<void> {
    await Promise.resolve();
    for (const h of this.partner.handlers.get(env.ns) ?? []) await h(env);
  }
}
function linkedBuses(): [BusEnd, BusEnd] {
  const a = new BusEnd(); const b = new BusEnd();
  a.partner = b; b.partner = a;
  return [a, b];
}

describe('conformance 向量：isCourierEligibleRecord', () => {
  const vectors: Array<[string, GossipMessage, boolean]> = [
    ['合法 nrec1 信封（chat 未標 channel）', rec(), true],
    ['合法 nrec1（channel:game）', rec({ channel: 'game', content: enc('g') }), true],
    ['合法 nrec1（channel:reaction）', rec({ channel: 'reaction', content: enc('r') }), true],
    ['合法 nrec1（channel:read）', rec({ channel: 'read', content: enc('w') }), true],
    ['合法 keyx1（channel:keyx，豁免 nrec1 要求）', rec({ channel: 'keyx', content: keyxContent() }), true],
    ['明文 chat', rec({ content: '純明文訊息' }), false],
    ['明文 game', rec({ channel: 'game', content: '{"v":1,"type":"move"}' }), false],
    ['明文 reaction', rec({ channel: 'reaction', content: '{"messageId":"m","emoji":"x"}' }), false],
    ['含 nrec1 標記但 parse 失敗', rec({ content: '{"v":"nrec1","ct":broken' }), false],
    ['nrec1 標記但欄位缺失', rec({ content: '{"v":"nrec1"}' }), false],
    ['channel:keyx 而 content 非 keyx1', rec({ channel: 'keyx', content: '明文假 keyx' }), false],
    ['channel:keyx 而 content 是 nrec1（keyx 不得被房間金鑰加密，形狀即違規）', rec({ channel: 'keyx', content: enc('k') }), false],
    ['空字串 content', rec({ content: '' }), false],
  ];
  for (const [name, record, ok] of vectors) {
    it(`${name} → ${ok ? '合格' : '不合格'}`, () => {
      expect(isCourierEligibleRecord(record)).toBe(ok);
    });
  }
});

describe('收側：CourierStore 拒收與清洗', () => {
  it('deposit 明文紀錄 → 拒收 reason plaintext-content；密文與 keyx 照收', () => {
    const s = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    expect(s.deposit(rec({ content: '明文' }))).toEqual({ accepted: false, reason: 'plaintext-content' });
    expect(s.deposit(rec({ seq: 2 })).accepted).toBe(true);
    expect(s.deposit(rec({ seq: 3, channel: 'keyx', content: keyxContent() })).accepted).toBe(true);
    expect(s.stats().recordCount).toBe(2);
  });

  it('hydrate 清洗：規則生效前寄存的明文紀錄不再代管並自耐久層刪除', async () => {
    const persisted = new Map<string, { roomId: string; msg: GossipMessage; depositedAt: number; bytes: number }>();
    const key = (r: string, s2: string, q: number) => `${r}|${s2}|${q}`;
    const plain = rec({ seq: 1, content: '歷史明文' });
    const cipher = rec({ seq: 2 });
    persisted.set(key('r1', 's1', 1), { roomId: 'r1', msg: plain, depositedAt: 900, bytes: 10 });
    persisted.set(key('r1', 's1', 2), { roomId: 'r1', msg: cipher, depositedAt: 900, bytes: 10 });
    const p = {
      putRecord: vi.fn(async () => undefined),
      deleteRecord: vi.fn(async (r: string, s2: string, q: number) => { persisted.delete(key(r, s2, q)); }),
      deleteRoom: vi.fn(async () => undefined),
      loadAll: vi.fn(async () => [...persisted.values()]),
      clear: vi.fn(async () => undefined),
    };
    const s = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000, p as never);
    await s.hydrate();
    await s.flush();
    expect(s.stats().recordCount).toBe(1); // 只回灌密文
    expect(s.serveRoom('r1').map((m) => m.seq)).toEqual([2]);
    expect(persisted.has(key('r1', 's1', 1))).toBe(false); // 明文已自耐久層刪除
  });
});

describe('推側：reconcile 與 runCourierBackup 不外送明文', () => {
  it('reconcile：成員混合持有明文＋密文＋keyx → 信使只收到密文與 keyx', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier-node').start();
    const client = new CourierClient(memberBus, 'member-uid');
    client.start();

    const records = [
      rec({ seq: 1, content: '形成期明文' }),
      rec({ seq: 2, content: enc('cipher-a') }),
      rec({ seq: 3, channel: 'keyx', content: keyxContent() }),
    ];
    // 呼叫端合約（runCourierBackup 同款）：digest 之前先過濾
    const eligible = filterCourierEligible(records);
    const eligibleStore = buildRoomStore(eligible);
    const { pushed } = await client.reconcile('r1', eligibleStore, new Map(), maxEpochs(eligibleStore), () => undefined);
    expect(pushed).toBe(2);
    const held = store.serveRoom('r1');
    expect(held.map((m) => m.seq).sort()).toEqual([2, 3]);
    expect(held.every(isCourierEligibleRecord)).toBe(true);
  });

  it('reconcile 防禦層：即使呼叫端漏過濾（digest 含明文），push 前仍被攔下', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier-node').start();
    const client = new CourierClient(memberBus, 'member-uid');
    client.start();

    const mixed = [rec({ seq: 1, content: '漏網明文' }), rec({ seq: 2 })];
    const mixedStore = buildRoomStore(mixed);
    const { pushed } = await client.reconcile('r1', mixedStore, new Map(), maxEpochs(mixedStore), () => undefined);
    expect(pushed).toBe(1); // 明文被 client 端防禦過濾，未計入
    expect(store.serveRoom('r1').map((m) => m.seq)).toEqual([2]);
  });

  it('runCourierBackup：持久層含明文 → 信使側最終只有合格紀錄', async () => {
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier-node').start();
    const client = new CourierClient(memberBus, 'member-uid');
    client.start();

    const deps: CourierBackupDeps = {
      listRooms: async () => ['r1'],
      discoverCourierUids: async () => ['courier-node'],
      openClient: async () => client,
      loadRoom: async () => ({
        records: [
          rec({ seq: 1, content: '持久層裡的明文' }),
          rec({ seq: 2, content: enc('cipher-b') }),
          rec({ seq: 3, channel: 'keyx', content: keyxContent() }),
        ],
        floors: [],
        acceptedEpochs: [],
      }),
      saveRecord: async () => undefined,
      verifyRecord: async () => true,
    };
    const summary = await runCourierBackup(deps);
    expect(summary.pushed).toBe(2);
    const held = store.serveRoom('r1');
    expect(held.map((m) => m.seq).sort()).toEqual([2, 3]);
    expect(held.every(isCourierEligibleRecord)).toBe(true);
  });
});
