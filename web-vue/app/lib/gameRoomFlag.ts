/**
 * 遊戲室旗標（Spec 006 T3）：dashboard「建立遊戲室」→ chat 頁自動開遊戲面板。
 * sessionStorage、一次性（讀完即清）、隱私模式靜默降級（手動開面板即可）。
 * 不動資料模型：遊戲入口＝露出既有的房內面板能力。
 */
const key = (roomId: string) => `nerilo:open-game:${roomId}`

export function markOpenGameFlag(roomId: string): void {
  try {
    sessionStorage.setItem(key(roomId), '1')
  } catch { /* 隱私模式 */ }
}

export function consumeOpenGameFlag(roomId: string): boolean {
  try {
    if (sessionStorage.getItem(key(roomId))) {
      sessionStorage.removeItem(key(roomId))
      return true
    }
  } catch { /* 隱私模式 */ }
  return false
}
