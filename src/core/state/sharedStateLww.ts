/**
 * 共享狀態的 LWW 收斂核心（Spec 025 T1）。純函式、零 I/O、可直測。
 *
 * 語義：per-key Last-Writer-Wins，裁決鍵 = (hlc.wallTime, hlc.logical, from) 字典序，
 * 大者勝；同裁決鍵視為同一筆（冪等）。刪除以墓碑記錄（防「刪除被舊增量復活」），
 * 墓碑活在會話存續期間（狀態不持久化，無回收問題）。
 * 快照與增量走同一套用函式 → 亂序、重複、快照/增量交錯全部收斂到同一視圖。
 */

import type { HLCTimestamp } from '../clock/HybridLogicalClock';

/** 一筆增量（線上 t:'d'）。v 缺席＝刪除（墓碑）。 */
export interface StateDelta {
  k: string;
  v?: unknown;
  hlc: HLCTimestamp;
  from: string;
}

/** 每 key 的收斂紀錄（含墓碑）。 */
export interface KeyRecord {
  v?: unknown;
  hlc: HLCTimestamp;
  from: string;
  deleted: boolean;
}

export type StateMap = Map<string, KeyRecord>;

/** 裁決鍵比較：正=a 勝。wallTime → logical → from（senderId）字典序。 */
export function compareStamp(
  a: { hlc: HLCTimestamp; from: string },
  b: { hlc: HLCTimestamp; from: string }
): number {
  if (a.hlc.wallTime !== b.hlc.wallTime) return a.hlc.wallTime - b.hlc.wallTime;
  if (a.hlc.logical !== b.hlc.logical) return a.hlc.logical - b.hlc.logical;
  return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
}

/**
 * 套用一筆增量。回傳是否改變了收斂視圖（同鍵舊值敗於現值 → false）。
 * 冪等：同一筆重複套用恆 false。
 */
export function applyDelta(map: StateMap, d: StateDelta): boolean {
  const existing = map.get(d.k);
  if (existing && compareStamp(existing, d) >= 0) return false; // 現值勝或同筆
  map.set(d.k, {
    ...('v' in d ? { v: d.v } : {}),
    hlc: d.hlc,
    from: d.from,
    deleted: !('v' in d),
  });
  return true;
}

/** 套用一批（快照 t:'s' 的內容物）。回傳實際改變的 key 清單。 */
export function applyBatch(map: StateMap, deltas: StateDelta[]): string[] {
  const changed: string[] = [];
  for (const d of deltas) if (applyDelta(map, d)) changed.push(d.k);
  return changed;
}

/** 匯出可傳輸的全狀態（含墓碑——收端需要墓碑才不會復活已刪 key）。 */
export function exportDeltas(map: StateMap): StateDelta[] {
  const out: StateDelta[] = [];
  for (const [k, r] of map) {
    out.push({ k, ...(r.deleted ? {} : { v: r.v }), hlc: r.hlc, from: r.from });
  }
  return out;
}

/** 收斂視圖（略過墓碑；深拷貝防呼叫端突變內部狀態）。值依契約為可 JSON 序列化。 */
export function toView(map: StateMap): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [k, r] of map) {
    if (!r.deleted) view[k] = r.v === undefined ? undefined : JSON.parse(JSON.stringify(r.v));
  }
  return view;
}
