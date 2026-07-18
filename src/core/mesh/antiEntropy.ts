import type { GossipMessage } from '../../types';

/**
 * seq-based anti-entropy 對帳（mesh 可靠性第三輪；Spec 009 起分代）
 *
 * 每個節點保存 (senderId, sessionEpoch, seq) → 已簽名訊息 的 store。
 * 週期性把自己的 digest 送給已連上鄰居；收到對方 digest 時，把「我有、對方缺」
 * 的訊息補送過去。
 *
 * 分代語義（Spec 009）：digest 每 sender 只宣告「現行代」的 floor/max/missing——
 * 宣告舊代是徒勞（收端的現行代門檻必拒），只會浪費補送頻寬。對方條目的代落後
 * 我方 → 對方全缺（我方現行代紀錄會把對方推進到新代）；對方的代比我方新 →
 * 我方已過時，不送。
 *
 * 收斂論證：同代之內 digest 交換一輪後兩節點間的對稱差嚴格縮小；跨代由
 * 「新代紀錄單向推進舊代持有者」收斂；訊息集有限、交換週期性發生、任一連通
 * 路徑皆可補 → 連通圖上收斂到「全員現行代聯集」。pull-based：訊息本體只在
 * 「確知對方缺」時才傳，digest 本身極小。
 */

/** 單一 sender 現行代的持有摘要：[floor..max] 中除 missing 外皆持有；floor 之前已淘汰、不再回補 */
export interface SenderHoldings {
  /** 該 sender 的現行會話代（Spec 009）；floor/max/missing 只描述此代 */
  epoch: number;
  floor: number;
  max: number;
  missing: number[];
}

/** 線上格式：senderId → holdings（gossip digest v2；缺 epoch 的 v1 digest 形狀檢查即失敗） */
export type GossipDigest = Record<string, SenderHoldings>;

/** 驗證+正規化後的 digest：missing 轉 Set，比對 O(1) */
export type NormalizedDigest = Map<
  string,
  { epoch: number; floor: number; max: number; missing: Set<number> }
>;

/** 分代 store：senderId → sessionEpoch → seq → 已簽名訊息 */
export type EpochStore = ReadonlyMap<
  string,
  ReadonlyMap<number, ReadonlyMap<number, GossipMessage>>
>;

/** 分代 floors：senderId → sessionEpoch → floor（舊代 inert，無 floor 語義） */
export type EpochFloors = ReadonlyMap<string, ReadonlyMap<number, number>>;

/** digest 中每 sender 的 missing 上限：超過的缺口留待後續輪次（只影響收斂速度，不影響收斂性） */
export const MAX_MISSING_PER_SENDER = 100;
/** 接受的 digest 上限（sender 數 / missing 長度）：擋畸形或惡意的巨型 digest */
const MAX_DIGEST_SENDERS = 64;
const MAX_DIGEST_MISSING = 500;

/**
 * 由本地分代 store + floors 計算要送給鄰居的 digest。
 * @param currentEpochs 每 sender 的宣告代：成員傳「已驗證的現行代」（acceptedEpochs）；
 *   盲信使等無驗證脈絡者傳 maxEpochs(store)。無宣告代的 sender（如僅持 legacy 0 代）不宣告。
 */
export function computeDigest(
  store: EpochStore,
  floors: EpochFloors,
  currentEpochs: ReadonlyMap<string, number>,
): GossipDigest {
  const digest: GossipDigest = {};
  for (const [senderId, epochs] of store) {
    const epoch = currentEpochs.get(senderId);
    if (epoch === undefined || epoch < 1) continue;
    const seqs = epochs.get(epoch);
    if (!seqs || seqs.size === 0) continue;
    const floor = floors.get(senderId)?.get(epoch) ?? 1;
    let max = 0;
    for (const seq of seqs.keys()) {
      if (seq > max) max = seq;
    }
    const missing: number[] = [];
    for (let s = floor; s <= max && missing.length < MAX_MISSING_PER_SENDER; s++) {
      if (!seqs.has(s)) missing.push(s);
    }
    digest[senderId] = { epoch, floor, max, missing };
  }
  return digest;
}

/**
 * 無驗證脈絡持有者（盲信使）的宣告代：每 sender 持有紀錄的最高代。
 * legacy（0 代）不宣告——v2 收端必拒，宣告只浪費頻寬。
 */
export function maxEpochs(store: EpochStore): Map<string, number> {
  const result = new Map<string, number>();
  for (const [senderId, epochs] of store) {
    let max = 0;
    for (const [epoch, seqs] of epochs) {
      if (seqs.size > 0 && epoch > max) max = epoch;
    }
    if (max >= 1) result.set(senderId, max);
  }
  return result;
}

/** 驗證網路來的 digest 形狀；不合法回傳 null（fail-closed）。合法則轉為查詢友善的 Map/Set。 */
export function normalizeDigest(raw: unknown): NormalizedDigest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DIGEST_SENDERS) return null;

  const normalized: NormalizedDigest = new Map();
  for (const [senderId, value] of entries) {
    if (typeof value !== 'object' || value === null) return null;
    const { epoch, floor, max, missing } = value as Partial<SenderHoldings>;
    if (
      typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1 ||
      typeof floor !== 'number' || !Number.isInteger(floor) || floor < 1 ||
      typeof max !== 'number' || !Number.isInteger(max) || max < 0 ||
      !Array.isArray(missing) || missing.length > MAX_DIGEST_MISSING ||
      missing.some((m) => typeof m !== 'number' || !Number.isInteger(m))
    ) {
      return null;
    }
    normalized.set(senderId, { epoch, floor, max, missing: new Set(missing) });
  }
  return normalized;
}

/**
 * 對方（依其 digest）是否缺 (senderId, epoch, seq)。
 * 對方沒聽過該 sender → 全缺；對方的代落後 → 全缺（補送會把對方推進新代）；
 * 對方的代較新 → 不缺（我方過時，送了必被拒）。
 */
export function peerLacks(
  digest: NormalizedDigest,
  senderId: string,
  epoch: number,
  seq: number,
): boolean {
  const h = digest.get(senderId);
  if (!h) return true;
  if (epoch > h.epoch) return true;
  if (epoch < h.epoch) return false;
  if (seq > h.max) return true;
  if (seq < h.floor) return false; // 對方已主動遺忘該區間，不回補
  return h.missing.has(seq);
}

/**
 * 從本地分代 store 選出對方 digest 明確缺少的紀錄（只考慮各 sender 的宣告代）；
 * digest 畸形時 fail-closed、不傳資料。
 */
export function recordsPeerLacks(
  store: EpochStore,
  peerDigestRaw: GossipDigest,
  currentEpochs: ReadonlyMap<string, number>,
): GossipMessage[] {
  const digest = normalizeDigest(peerDigestRaw);
  if (!digest) return [];
  const records: GossipMessage[] = [];
  for (const [senderId, epochs] of store) {
    const epoch = currentEpochs.get(senderId);
    if (epoch === undefined || epoch < 1) continue;
    const seqs = epochs.get(epoch);
    if (!seqs) continue;
    for (const [seq, message] of seqs) {
      if (peerLacks(digest, senderId, epoch, seq)) records.push(message);
    }
  }
  return records;
}
