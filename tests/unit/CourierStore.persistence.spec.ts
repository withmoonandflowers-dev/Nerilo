/**
 * CourierStore 持久化測試（ADR-0024 收官）——記憶體為權威 + 耐久層鏡像。
 * 用假 CourierPersistence 驗：deposit/移除都鏡像到耐久層；hydrate 重建記憶體、跳過並清逾期；
 * flush 等寫入落定；未注入 persistence 時行為不變（純記憶體）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  CourierStore,
  DEFAULT_COURIER_CONFIG,
  type CourierPersistence,
  type PersistedCourierRecord,
} from '../../src/core/relay/CourierStore';
import type { GossipMessage } from '../../src/types';
import { enc, encSized } from './_courierFixtures';

function msg(over: Partial<GossipMessage> = {}): GossipMessage {
  return { roomId: 'r1', senderId: 's1', pubKey: 'pk', seq: 1, timestamp: 1000, content: enc('x'), ttl: 3, signature: 'sig', ...over };
}

/** 假耐久層：Map 存 + 記錄呼叫序列。 */
function fakePersistence() {
  const store = new Map<string, PersistedCourierRecord>();
  const calls: string[] = [];
  const key = (roomId: string, senderId: string, seq: number) => `${roomId}|${senderId}|${seq}`;
  const p: CourierPersistence = {
    async putRecord(rec) { calls.push('put'); store.set(key(rec.roomId, rec.msg.senderId, rec.msg.seq), rec); },
    async deleteRecord(roomId, senderId, seq) { calls.push('delRec'); store.delete(key(roomId, senderId, seq)); },
    async deleteRoom(roomId) { calls.push('delRoom'); for (const k of [...store.keys()]) if (k.startsWith(`${roomId}|`)) store.delete(k); },
    async loadAll() { return [...store.values()]; },
    async clear() { calls.push('clear'); store.clear(); },
  };
  return { p, store, calls };
}

const cfg = (over = {}) => ({ ...DEFAULT_COURIER_CONFIG, ...over });

describe('CourierStore 持久化 — 鏡像', () => {
  it('deposit 鏡像 putRecord；flush 後耐久層有該筆', async () => {
    const { p, store } = fakePersistence();
    const s = new CourierStore(cfg(), () => 1000, p);
    s.deposit(msg({ seq: 1, content: enc('a') }));
    await s.flush();
    expect(store.size).toBe(1);
    expect([...store.values()][0]!.msg.content).toBe(enc('a'));
  });

  it('墓碑刪整房 → deleteRoom 鏡像', async () => {
    const { p, store, calls } = fakePersistence();
    const s = new CourierStore(cfg(), () => 1000, p);
    s.deposit(msg({ seq: 1 }));
    s.deposit(msg({ seq: 2 }));
    await s.applyTombstone('r1', () => true);
    await s.flush();
    expect(store.size).toBe(0);
    expect(calls).toContain('delRoom');
  });

  it('TTL 過期清除 → deleteRecord 鏡像', async () => {
    const { p, store } = fakePersistence();
    let t = 1000;
    const s = new CourierStore(cfg({ ttlMs: 100 }), () => t, p);
    s.deposit(msg({ seq: 1 }));
    t = 2000;
    s.evictExpired();
    await s.flush();
    expect(store.size).toBe(0);
  });

  it('clearAll → clear 鏡像', async () => {
    const { p, store, calls } = fakePersistence();
    const s = new CourierStore(cfg(), () => 1000, p);
    s.deposit(msg({ roomId: 'r1' }));
    s.deposit(msg({ roomId: 'r2' }));
    s.clearAll();
    await s.flush();
    expect(store.size).toBe(0);
    expect(calls).toContain('clear');
  });

  it('單房超上限淘汰 → deleteRecord 鏡像（耐久層與記憶體一致）', async () => {
    const { p, store } = fakePersistence();
    let t = 1000;
    const s = new CourierStore(cfg({ maxRoomBytes: 200, maxRecordBytes: 100 }), () => t, p);
    for (let seq = 1; seq <= 5; seq++) { t = 1000 + seq; s.deposit(msg({ senderId: 'a', seq, content: encSized(100), signature: '' })); } // 100 bytes each（Spec 012：content 須為合法信封，等比放大原 5-byte 案例）
    await s.flush();
    // 記憶體與耐久層都只留最新 2 筆（房上限 10 / 每筆 5）
    expect(s.stats().recordCount).toBe(2);
    expect(store.size).toBe(2);
  });
});

describe('CourierStore 持久化 — hydrate', () => {
  it('從耐久層載回代管紀錄（重載模擬）', async () => {
    const { p } = fakePersistence();
    // 先用一個 store 存兩筆
    const s1 = new CourierStore(cfg(), () => 1000, p);
    s1.deposit(msg({ senderId: 'a', seq: 1, content: enc('1') }));
    s1.deposit(msg({ senderId: 'a', seq: 2, content: enc('2') }));
    await s1.flush();

    // 新 store（模擬重載）hydrate → 記憶體重建
    const s2 = new CourierStore(cfg(), () => 2000, p);
    expect(s2.stats().recordCount).toBe(0);
    await s2.hydrate();
    expect(s2.stats().recordCount).toBe(2);
    expect(s2.serveRoom('r1').map((m) => m.content).sort()).toEqual([enc('1'), enc('2')].sort());
  });

  it('hydrate 跳過並清除逾 TTL 的持久紀錄', async () => {
    const { p, store } = fakePersistence();
    const s1 = new CourierStore(cfg({ ttlMs: 100 }), () => 1000, p);
    s1.deposit(msg({ seq: 1 })); // depositedAt=1000
    await s1.flush();

    // 重載時已是 t=2000（逾 TTL 100）→ hydrate 不載入且刪除
    const s2 = new CourierStore(cfg({ ttlMs: 100 }), () => 2000, p);
    await s2.hydrate();
    await s2.flush();
    expect(s2.stats().recordCount).toBe(0);
    expect(store.size).toBe(0); // 逾期的也從耐久層清掉
  });

  it('hydrate 冪等：記憶體已有的 (sender,seq) 不覆寫、不重複計位元組', async () => {
    const { p } = fakePersistence();
    const s = new CourierStore(cfg(), () => 1000, p);
    s.deposit(msg({ senderId: 'a', seq: 1 }));
    await s.flush();
    const before = s.stats().totalBytes;
    await s.hydrate(); // 同一 store 再 hydrate
    expect(s.stats().recordCount).toBe(1);
    expect(s.stats().totalBytes).toBe(before);
  });
});

describe('CourierStore 持久化 — 未注入', () => {
  it('無 persistence → flush/hydrate 為 no-op，行為不變', async () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ seq: 1 }));
    await s.flush();
    await s.hydrate();
    expect(s.stats().recordCount).toBe(1);
  });
});
