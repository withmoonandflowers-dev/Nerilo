/**
 * CourierStore 性質測試（ADR-0024 不變量）——隨機 deposit 序列下恆成立：
 *  I1. 總量永不超總預算（預算 LRU 生效）。
 *  I2. 每房永不超單房上限（房內 FIFO 淘汰生效）。
 *  I3. stats().totalBytes 與逐房實際位元組總和一致（會計不漂移）。
 *  I4. serveRoom 回傳的紀錄數 == 該房 stats 視角的紀錄數（無幽靈/漏算）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CourierStore, recordBytes, type CourierStoreConfig } from '../../src/core/relay/CourierStore';
import type { GossipMessage } from '../../src/types';
import { encSized } from './_courierFixtures';

function mk(roomId: string, senderId: string, seq: number, contentBytes: number): GossipMessage {
  return {
    roomId,
    senderId,
    pubKey: 'pk',
    seq,
    timestamp: 0,
    // Spec 012：content 須為合法信封；encSized 保精確位元組數（min 36），
    // 生成尺寸整體平移 +36、config 等比對應，量測語義不變。
    content: encSized(36 + contentBytes),
    ttl: 3,
    signature: '',
  };
}

const config: CourierStoreConfig = {
  maxRecordBytes: 86, // 36+50：與生成尺寸同平移，維持「有時超限被拒」覆蓋
  maxRoomBytes: 344, // ≈4 筆滿額紀錄（原 200/50=4）
  totalBudgetBytes: 860, // ≈10 筆滿額紀錄（原 500/50=10）
  ttlMs: 1_000_000,
};

const depositArb = fc.record({
  room: fc.constantFrom('r1', 'r2', 'r3', 'r4'),
  sender: fc.constantFrom('a', 'b', 'c'),
  seq: fc.integer({ min: 1, max: 30 }),
  size: fc.integer({ min: 1, max: 70 }), // 有時 > maxRecordBytes(50) → 應被拒
  tick: fc.integer({ min: 0, max: 5 }),
});

function sumRoomBytes(s: CourierStore, rooms: string[]): number {
  // 由公開視圖重算，交叉核對內部會計
  let total = 0;
  for (const roomId of rooms) {
    for (const m of s.serveRoom(roomId)) total += recordBytes(m);
  }
  return total;
}

describe('CourierStore — 不變量（性質測試）', () => {
  it('任意 deposit 序列後：總量 ≤ 預算、每房 ≤ 房上限、會計一致', () => {
    fc.assert(
      fc.property(fc.array(depositArb, { minLength: 0, maxLength: 200 }), (ops) => {
        let t = 0;
        const s = new CourierStore(config, () => t);
        const rooms = ['r1', 'r2', 'r3', 'r4'];
        for (const op of ops) {
          t += op.tick;
          s.deposit(mk(op.room, op.sender, op.seq, op.size));
        }
        const stats = s.stats();

        // I1：總量 ≤ 預算
        expect(stats.totalBytes).toBeLessThanOrEqual(config.totalBudgetBytes);

        // I2：每房 ≤ 房上限（用公開視圖重算房位元組）
        for (const roomId of rooms) {
          const roomBytes = s.serveRoom(roomId).reduce((n, m) => n + recordBytes(m), 0);
          expect(roomBytes).toBeLessThanOrEqual(config.maxRoomBytes);
        }

        // I3：內部會計 == 公開視圖總和（serveRoom 保鮮不改總量）
        // 注意：serveRoom 觸發 evictExpired，但 ttl 極大 → 不清任何東西，故一致。
        expect(sumRoomBytes(s, rooms)).toBe(s.stats().totalBytes);

        // I4：serveRoom 紀錄數總和 == stats.recordCount
        const served = rooms.reduce((n, r) => n + s.serveRoom(r).length, 0);
        expect(served).toBe(s.stats().recordCount);
      }),
      { numRuns: 300 }
    );
  });

  it('被接受的紀錄一定 ≤ maxRecordBytes（拒收邊界正確）', () => {
    fc.assert(
      fc.property(fc.array(depositArb, { maxLength: 100 }), (ops) => {
        let t = 0;
        const s = new CourierStore(config, () => t);
        for (const op of ops) {
          t += op.tick;
          s.deposit(mk(op.room, op.sender, op.seq, op.size));
        }
        for (const roomId of ['r1', 'r2', 'r3', 'r4']) {
          for (const m of s.serveRoom(roomId)) {
            expect(recordBytes(m)).toBeLessThanOrEqual(config.maxRecordBytes);
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});
