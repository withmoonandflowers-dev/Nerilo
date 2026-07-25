/**
 * 已讀人數純邏輯（水位聚合 reducer；與 UI/傳輸解耦，可測）
 *
 * 模型 = 每人一個「已讀水位」watermark：我已讀到的最高訊息位置（orderKey）。
 * 事件走 mesh 'read' 通道（與聊天同 E2EE、同可靠管線），到達順序不保證但冪等且單調：
 * applyRead 對每人取 max → 亂序、重送、重進房都收斂一致、不會讓已讀數倒退。
 *
 * 某則訊息的已讀數 = 「水位 ≥ 該訊息 orderKey」的成員數（排除作者本人）。
 * 用 per-member 單值（O(人)）而非 per-message 標記（O(訊息×人)）→ mesh 頻寬友善。
 *
 * orderKey：把 HLC（wallTime, logical）序列化成「等寬零填字串」，字典序 == 數值序；
 * 沒有 hlc 的舊訊息退回 timestamp（皆為牆鐘毫秒，可與 hlc.wallTime 互比）。刻意不直接
 * 用 HybridLogicalClock.toString——它的 wallTime 未零填，"9" 會排在 "10" 之後。
 */
import type { HLCTimestamp } from '../../types';

/** 一則已讀事件 = 某人（from）的水位推進到 watermark（orderKey 字串）。 */
export interface ReadEvent {
  from: string;
  watermark: string;
}

/** from → 該成員目前最高水位（orderKey）。 */
export type ReadState = Record<string, string>;

const WALL_WIDTH = 15; // 毫秒牆鐘零填寬度（涵蓋到約西元 33658 年）
const LOGICAL_WIDTH = 6;

/** 訊息位置 → 可字典序比較的 orderKey。hlc 優先，退回 timestamp。 */
export function orderKeyOf(msg: { timestamp: number; hlc?: HLCTimestamp }): string {
  const wall = msg.hlc ? msg.hlc.wallTime : msg.timestamp;
  const logical = msg.hlc ? msg.hlc.logical : 0;
  const w = Math.max(0, Math.floor(wall));
  const l = Math.max(0, Math.floor(logical));
  return `${String(w).padStart(WALL_WIDTH, '0')}.${String(l).padStart(LOGICAL_WIDTH, '0')}`;
}

/** 套用一個已讀事件，回傳新聚合（不可變更新；每人取 max，單調不倒退）。 */
export function applyRead(state: ReadState, ev: ReadEvent): ReadState {
  if (!ev || typeof ev.from !== 'string' || typeof ev.watermark !== 'string') {
    return state;
  }
  const prev = state[ev.from];
  if (prev !== undefined && prev >= ev.watermark) return state; // 非前進 → no-op（冪等）
  return { ...state, [ev.from]: ev.watermark };
}

/**
 * 某則訊息的已讀人數。
 * 一律排除作者本人（自己寫的不算已讀）；exclude 供再排除「我」等（顯示自己訊息時）。
 */
export function readCount(
  state: ReadState,
  msgKey: string,
  author: string,
  exclude: string[] = []
): number {
  const skip = new Set<string>([author, ...exclude]);
  let n = 0;
  for (const from in state) {
    if (skip.has(from)) continue;
    if (state[from] >= msgKey) n++;
  }
  return n;
}

/** 已讀某則訊息的成員清單（去重排序；供 hover 名單，MVP 預設不顯示）。 */
export function readersOf(
  state: ReadState,
  msgKey: string,
  author: string,
  exclude: string[] = []
): string[] {
  const skip = new Set<string>([author, ...exclude]);
  const out: string[] = [];
  for (const from in state) {
    if (skip.has(from)) continue;
    if (state[from] >= msgKey) out.push(from);
  }
  return out.sort();
}
