/**
 * 配額純邏輯（M-7）。
 *
 * 與 firebase-admin / functions runtime 解耦以便單元測試——同 netlify 的
 * webhook-core 分家做法：這裡只做「固定視窗計數」的判定，交易與 IO 留在 index.ts。
 */

export interface QuotaState {
  /** 目前視窗的起始毫秒時間戳 */
  windowStart: number;
  /** 目前視窗內已用次數 */
  count: number;
}

export interface QuotaDecision {
  allowed: boolean;
  /** 應寫回的新狀態（allowed=false 時維持原狀，不累加） */
  state: QuotaState;
}

/**
 * 固定視窗計數判定。
 *
 * - 視窗已過期：開新視窗，計為第 1 次 → 放行
 * - 視窗內未達上限：累加 → 放行
 * - 視窗內已達上限：不累加 → 拒絕（拒絕不延長視窗，避免被打成永久封鎖）
 */
export function decideQuota(
  current: Partial<QuotaState> | undefined,
  now: number,
  windowMs: number,
  max: number
): QuotaDecision {
  // 無既有狀態（或欄位畸形）一律當「開新視窗」處理。不可只靠 windowStart 預設 0
  // 再比 now - 0 >= windowMs——那要 now 夠大才成立，等於把正確性押在絕對時間的量級上。
  const hasWindow =
    typeof current?.windowStart === 'number' && Number.isFinite(current.windowStart);
  const count = typeof current?.count === 'number' && Number.isFinite(current.count)
    ? current.count
    : 0;

  if (!hasWindow) {
    return { allowed: true, state: { windowStart: now, count: 1 } };
  }
  const windowStart = current!.windowStart as number;

  if (now - windowStart >= windowMs) {
    return { allowed: true, state: { windowStart: now, count: 1 } };
  }
  if (count >= max) {
    return { allowed: false, state: { windowStart, count } };
  }
  return { allowed: true, state: { windowStart, count: count + 1 } };
}
