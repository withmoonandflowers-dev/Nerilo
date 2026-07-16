import type { GossipMessage } from '../../types';

/**
 * seq-based anti-entropy 對帳（mesh 可靠性第三輪）
 *
 * 每個節點保存 (senderId, seq) → 已簽名訊息 的 store（房間會話生命週期）。
 * 週期性把自己的 digest（每 sender 的 floor/max/missing）送給已連上鄰居；
 * 收到對方 digest 時，把「我有、對方缺」的訊息補送過去。
 *
 * 收斂論證：digest 交換一輪後，兩節點間的對稱差嚴格縮小；訊息集有限、
 * 交換週期性發生、任一連通路徑皆可補 → 連通圖上必然收斂到全員一致。
 * pull-based：訊息本體只在「確知對方缺」時才傳，digest 本身極小。
 */

/** 單一 sender 的持有摘要：[floor..max] 中除 missing 外皆持有；floor 之前已淘汰、不再回補 */
export interface SenderHoldings {
  floor: number;
  max: number;
  missing: number[];
}

/** 線上格式：senderId → holdings */
export type GossipDigest = Record<string, SenderHoldings>;

/** 驗證+正規化後的 digest：missing 轉 Set，比對 O(1) */
export type NormalizedDigest = Map<string, { floor: number; max: number; missing: Set<number> }>;

/** digest 中每 sender 的 missing 上限：超過的缺口留待後續輪次（只影響收斂速度，不影響收斂性） */
export const MAX_MISSING_PER_SENDER = 100;
/** 接受的 digest 上限（sender 數 / missing 長度）：擋畸形或惡意的巨型 digest */
const MAX_DIGEST_SENDERS = 64;
const MAX_DIGEST_MISSING = 500;

/** 由本地 store + floors 計算要送給鄰居的 digest */
export function computeDigest(
  store: ReadonlyMap<string, ReadonlyMap<number, GossipMessage>>,
  floors: ReadonlyMap<string, number>,
): GossipDigest {
  const digest: GossipDigest = {};
  for (const [senderId, seqs] of store) {
    const floor = floors.get(senderId) ?? 1;
    let max = 0;
    for (const seq of seqs.keys()) {
      if (seq > max) max = seq;
    }
    const missing: number[] = [];
    for (let s = floor; s <= max && missing.length < MAX_MISSING_PER_SENDER; s++) {
      if (!seqs.has(s)) missing.push(s);
    }
    digest[senderId] = { floor, max, missing };
  }
  return digest;
}

/** 驗證網路來的 digest 形狀；不合法回傳 null。合法則轉為查詢友善的 Map/Set。 */
export function normalizeDigest(raw: unknown): NormalizedDigest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DIGEST_SENDERS) return null;

  const normalized: NormalizedDigest = new Map();
  for (const [senderId, value] of entries) {
    if (typeof value !== 'object' || value === null) return null;
    const { floor, max, missing } = value as Partial<SenderHoldings>;
    if (
      typeof floor !== 'number' || !Number.isInteger(floor) || floor < 1 ||
      typeof max !== 'number' || !Number.isInteger(max) || max < 0 ||
      !Array.isArray(missing) || missing.length > MAX_DIGEST_MISSING ||
      missing.some((m) => typeof m !== 'number' || !Number.isInteger(m))
    ) {
      return null;
    }
    normalized.set(senderId, { floor, max, missing: new Set(missing) });
  }
  return normalized;
}

/** 對方（依其 digest）是否缺 (senderId, seq)。對方沒聽過該 sender → 全缺。 */
export function peerLacks(digest: NormalizedDigest, senderId: string, seq: number): boolean {
  const h = digest.get(senderId);
  if (!h) return true;
  if (seq > h.max) return true;
  if (seq < h.floor) return false; // 對方已主動遺忘該區間，不回補
  return h.missing.has(seq);
}

/** 從本地 store 選出對方 digest 明確缺少的紀錄；digest 畸形時 fail-closed、不傳資料。 */
export function recordsPeerLacks(
  store: ReadonlyMap<string, ReadonlyMap<number, GossipMessage>>,
  peerDigestRaw: GossipDigest,
): GossipMessage[] {
  const digest = normalizeDigest(peerDigestRaw);
  if (!digest) return [];
  const records: GossipMessage[] = [];
  for (const [senderId, seqs] of store) {
    for (const [seq, message] of seqs) {
      if (peerLacks(digest, senderId, seq)) records.push(message);
    }
  }
  return records;
}
