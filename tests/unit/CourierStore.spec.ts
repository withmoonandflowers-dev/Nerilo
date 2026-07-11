/**
 * CourierStore 單元測試（ADR-0024 盲信使儲存經濟學）
 *
 * 逐條驗 ADR-0024 決策：存完整密文、單筆/單房/總預算配額、TTL、預算 LRU（淘汰整房）、
 * 簽章墓碑刪除、first-write-wins（寄件人分叉現況策略）、使用者清空。純邏輯、注入時鐘。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { CourierStore, recordBytes, type CourierStoreConfig } from '../../src/core/relay/CourierStore';
import type { GossipMessage } from '../../src/types';

function msg(over: Partial<GossipMessage> = {}): GossipMessage {
  return {
    roomId: 'r1',
    senderId: 's1',
    pubKey: 'pk',
    seq: 1,
    timestamp: 1000,
    content: 'cipher-envelope',
    ttl: 3,
    signature: 'sig',
    ...over,
  };
}

/** 造一個 content 恰好 nBytes 的紀錄（signature 固定小），供配額邊界測試。 */
function sizedMsg(over: Partial<GossipMessage>, contentBytes: number): GossipMessage {
  return msg({ ...over, content: 'x'.repeat(contentBytes), signature: '' });
}

const cfg = (over: Partial<CourierStoreConfig> = {}): CourierStoreConfig => ({
  maxRecordBytes: 4 * 1024,
  maxRoomBytes: 5 * 1024 * 1024,
  totalBudgetBytes: 100 * 1024 * 1024,
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  ...over,
});

describe('CourierStore — deposit 基本', () => {
  it('存下密文紀錄、可原樣取回（存完整密文，非 hash）', () => {
    const s = new CourierStore(cfg(), () => 1000);
    const m = msg({ content: 'ENC:abc', signature: 'SIG:xyz' });
    const res = s.deposit(m);
    expect(res.accepted).toBe(true);
    const served = s.serveRoom('r1');
    expect(served).toHaveLength(1);
    expect(served[0]!.content).toBe('ENC:abc'); // 原樣，未被改動
    expect(served[0]!.signature).toBe('SIG:xyz');
  });

  it('has() 反映 (senderId, seq) 是否已存', () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ senderId: 'a', seq: 5 }));
    expect(s.has('r1', 'a', 5)).toBe(true);
    expect(s.has('r1', 'a', 6)).toBe(false);
    expect(s.has('r2', 'a', 5)).toBe(false);
  });

  it('stats 統計位元組/房數/紀錄數', () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ roomId: 'r1', senderId: 'a', seq: 1 }));
    s.deposit(msg({ roomId: 'r1', senderId: 'b', seq: 1 }));
    s.deposit(msg({ roomId: 'r2', senderId: 'a', seq: 1 }));
    const st = s.stats();
    expect(st.roomCount).toBe(2);
    expect(st.recordCount).toBe(3);
    expect(st.totalBytes).toBeGreaterThan(0);
  });
});

describe('CourierStore — 配額（ADR-0024 Decision 2）', () => {
  it('單筆超 4KB → 拒收', () => {
    const s = new CourierStore(cfg({ maxRecordBytes: 100 }), () => 1000);
    const res = s.deposit(sizedMsg({}, 101));
    expect(res).toEqual({ accepted: false, reason: 'record-too-large' });
    expect(s.stats().recordCount).toBe(0);
  });

  it('恰好等於上限 → 收', () => {
    const s = new CourierStore(cfg({ maxRecordBytes: 100 }), () => 1000);
    const res = s.deposit(sizedMsg({}, 100));
    expect(res.accepted).toBe(true);
  });

  it('總預算 0 → 不參與（一律拒收）', () => {
    const s = new CourierStore(cfg({ totalBudgetBytes: 0 }), () => 1000);
    expect(s.deposit(msg()).accepted).toBe(false);
    expect(s.stats().recordCount).toBe(0);
  });

  it('單房超上限 → 淘汰房內最舊寄存，保住上限', () => {
    // 房上限 300B；每筆 100B；存 5 筆（時序遞增）→ 只留最新 3 筆
    let t = 1000;
    const s = new CourierStore(cfg({ maxRoomBytes: 300, maxRecordBytes: 100 }), () => t);
    for (let seq = 1; seq <= 5; seq++) {
      t = 1000 + seq;
      s.deposit(sizedMsg({ senderId: 'a', seq }, 100));
    }
    const seqs = s.serveRoom('r1').map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([3, 4, 5]); // 最舊的 1,2 被淘汰
  });
});

describe('CourierStore — 預算 LRU 淘汰整房（Decision 3.2）', () => {
  it('總量觸頂 → 淘汰最久未被存取的整房', () => {
    let t = 0;
    // 總預算 250B，每筆 100B。存 r1、r2、r3 各一筆 = 300B > 250B。
    const s = new CourierStore(cfg({ totalBudgetBytes: 250, maxRoomBytes: 1000, maxRecordBytes: 100 }), () => t);
    t = 10; s.deposit(sizedMsg({ roomId: 'r1', seq: 1 }, 100));
    t = 20; s.deposit(sizedMsg({ roomId: 'r2', seq: 1 }, 100));
    t = 30; s.deposit(sizedMsg({ roomId: 'r3', seq: 1 }, 100)); // 觸頂 → 淘汰最久未存取(r1)
    expect(s.serveRoom('r1')).toHaveLength(0);
    expect(s.serveRoom('r2')).toHaveLength(1);
    expect(s.serveRoom('r3')).toHaveLength(1);
  });

  it('serveRoom 保鮮：被讀過的房不會先被淘汰', () => {
    let t = 0;
    const s = new CourierStore(cfg({ totalBudgetBytes: 250, maxRoomBytes: 1000, maxRecordBytes: 100 }), () => t);
    t = 10; s.deposit(sizedMsg({ roomId: 'r1', seq: 1 }, 100));
    t = 20; s.deposit(sizedMsg({ roomId: 'r2', seq: 1 }, 100));
    t = 25; s.serveRoom('r1'); // r1 被存取 → 變最新
    t = 30; s.deposit(sizedMsg({ roomId: 'r3', seq: 1 }, 100)); // 觸頂 → 淘汰 r2（最久未存取）
    expect(s.serveRoom('r1')).toHaveLength(1);
    expect(s.serveRoom('r2')).toHaveLength(0);
  });
});

describe('CourierStore — TTL（Decision 3.1）', () => {
  it('逾 TTL 的紀錄被 evictExpired 清除', () => {
    let t = 1000;
    const s = new CourierStore(cfg({ ttlMs: 100 }), () => t);
    s.deposit(msg({ seq: 1 })); // depositedAt=1000
    t = 1050;
    s.deposit(msg({ seq: 2 })); // depositedAt=1050
    t = 1101; // seq1 已逾期(1000+100=1100)，seq2 未逾(1050+100=1150)
    const removed = s.evictExpired();
    expect(removed).toBe(1);
    expect(s.has('r1', 's1', 1)).toBe(false);
    expect(s.has('r1', 's1', 2)).toBe(true);
  });

  it('serveRoom 前會清過期 → 不吐逾 TTL 紀錄', () => {
    let t = 1000;
    const s = new CourierStore(cfg({ ttlMs: 100 }), () => t);
    s.deposit(msg({ seq: 1 }));
    t = 2000;
    expect(s.serveRoom('r1')).toHaveLength(0);
  });
});

describe('CourierStore — 簽章墓碑（Decision 3.3）', () => {
  it('驗章過 → 刪整房、回傳釋放位元組', async () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ seq: 1 }));
    s.deposit(msg({ seq: 2 }));
    const before = s.stats().totalBytes;
    const freed = await s.applyTombstone('r1', () => true);
    expect(freed).toBe(before);
    expect(s.serveRoom('r1')).toHaveLength(0);
    expect(s.stats().totalBytes).toBe(0);
  });

  it('驗章不過 → 不刪、回傳 0（盲的也擋得住偽墓碑）', async () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ seq: 1 }));
    const freed = await s.applyTombstone('r1', () => false);
    expect(freed).toBe(0);
    expect(s.serveRoom('r1')).toHaveLength(1);
  });

  it('async verify（真實驗章是 async crypto）', async () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ seq: 1 }));
    const freed = await s.applyTombstone('r1', async () => Promise.resolve(true));
    expect(freed).toBeGreaterThan(0);
  });
});

describe('CourierStore — first-write-wins + 主權', () => {
  it('同 (senderId, seq) 重複寄存 → 保留首筆、不覆寫（寄件人分叉防禦）', () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ senderId: 'a', seq: 1, content: 'FIRST', signature: 's' }));
    const dup = s.deposit(msg({ senderId: 'a', seq: 1, content: 'SECOND', signature: 's' }));
    expect(dup).toEqual({ accepted: false, reason: 'duplicate' });
    expect(s.serveRoom('r1')[0]!.content).toBe('FIRST');
  });

  it('clearAll 清空全部代存', () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ roomId: 'r1' }));
    s.deposit(msg({ roomId: 'r2' }));
    s.clearAll();
    expect(s.stats()).toEqual({ totalBytes: 0, roomCount: 0, recordCount: 0 });
  });
});

describe('CourierStore — roomStore 視圖（anti-entropy 相容）', () => {
  it('形狀為 Map<senderId, Map<seq, GossipMessage>>', () => {
    const s = new CourierStore(cfg(), () => 1000);
    s.deposit(msg({ senderId: 'a', seq: 1 }));
    s.deposit(msg({ senderId: 'a', seq: 2 }));
    s.deposit(msg({ senderId: 'b', seq: 1 }));
    const view = s.roomStore('r1');
    expect([...view.keys()].sort()).toEqual(['a', 'b']);
    expect([...view.get('a')!.keys()].sort((x, y) => x - y)).toEqual([1, 2]);
    expect(view.get('a')!.get(1)!.senderId).toBe('a');
  });

  it('未知房 → 空 Map', () => {
    const s = new CourierStore(cfg(), () => 1000);
    expect(s.roomStore('nope').size).toBe(0);
  });
});

describe('recordBytes', () => {
  it('以 content + signature 的 UTF-8 位元組計（多位元組字元計 >1）', () => {
    expect(recordBytes(msg({ content: 'abc', signature: 'de' }))).toBe(5);
    expect(recordBytes(msg({ content: '中', signature: '' }))).toBe(3); // UTF-8 3 bytes
  });
});
