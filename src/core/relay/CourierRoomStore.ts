/**
 * CourierService 的房間 anti-entropy 視圖轉換。
 *
 * 本檔只把持久紀錄整理成 sender、世代與序號三層索引，讓信使對帳與測試共用，
 * 不處理傳輸、驗簽或寄存政策。
 */
import type { GossipMessage } from '../../types';

/**
 * 由紀錄陣列建分代 anti-entropy store 視圖（Spec 009）：
 * Map<senderId, Map<sessionEpoch, Map<seq, GossipMessage>>>。
 * 缺 sessionEpoch 的 legacy 紀錄進 0 代桶（永不宣告/補送，v2 收端必拒）。
 */
export function buildRoomStore(
  records: GossipMessage[]
): Map<string, Map<number, Map<number, GossipMessage>>> {
  const store = new Map<string, Map<number, Map<number, GossipMessage>>>();
  for (const message of records) {
    const epoch = Number.isSafeInteger(message.sessionEpoch) && message.sessionEpoch >= 1
      ? message.sessionEpoch
      : 0;
    let epochs = store.get(message.senderId);
    if (!epochs) {
      epochs = new Map<number, Map<number, GossipMessage>>();
      store.set(message.senderId, epochs);
    }
    let sequence = epochs.get(epoch);
    if (!sequence) {
      sequence = new Map<number, GossipMessage>();
      epochs.set(epoch, sequence);
    }
    if (!sequence.has(message.seq)) sequence.set(message.seq, message); // first-write-wins（對齊 CourierStore）
  }
  return store;
}
