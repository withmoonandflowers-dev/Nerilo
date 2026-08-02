/**
 * gossip store 的唯讀檢視純函式（Spec 018）。
 * store 形狀：senderId → sessionEpoch → seq → GossipMessage。
 * 抽出自 GossipMessageHandler（god-file 棘輪），零狀態、可獨立單測。
 */
import type { GossipMessage } from '../../types';

type GossipStore = Map<string, Map<number, Map<number, GossipMessage>>>;

/** store 是否已有他人（senderId ≠ self）的紀錄——「房間已運轉」的最小證據。 */
export function storeHasRecordsFromOthers(store: GossipStore, selfUserId: string): boolean {
  for (const [senderId, epochs] of store) {
    if (senderId === selfUserId) continue;
    for (const seqs of epochs.values()) {
      if (seqs.size > 0) return true;
    }
  }
  return false;
}

/**
 * store 中觀察到的最高 keyx（房間金鑰）epoch；-1 = 未見。
 * keys[].epoch 是明文 metadata——開不了鑰（未封給我）也讀得到，
 * 產生方交接據此以 observed+1 分發（Spec 018 閘門 4）。
 */
export function maxObservedKeyxEpoch(store: GossipStore): number {
  let max = -1;
  for (const epochs of store.values()) {
    for (const seqs of epochs.values()) {
      for (const msg of seqs.values()) {
        if (msg.channel !== 'keyx') continue;
        try {
          const payload = JSON.parse(msg.content) as { keys?: Array<{ epoch?: unknown }> };
          for (const k of payload.keys ?? []) {
            if (typeof k.epoch === 'number' && Number.isSafeInteger(k.epoch) && k.epoch > max) {
              max = k.epoch;
            }
          }
        } catch {
          /* 畸形 keyx 忽略 */
        }
      }
    }
  }
  return max;
}
