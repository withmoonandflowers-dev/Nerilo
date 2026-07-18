/**
 * 聊天顯示層純推導（自 [roomId].vue 抽出，god-file 棘輪配套）：
 * reactions 聚合 → 顯示 chips；已讀水位 → 顯示文字；加密狀態 → 標籤。
 * 全部是無副作用的純函數，方便單測與跨頁複用。
 */
import { readCount, orderKeyOf } from '@legacy/features/chat/readReceipts'
import type { ReadState } from '@legacy/features/chat/readReceipts'
import type { ReactionMap } from '@legacy/features/chat/reactions'
import type { ChatMessage } from '@legacy/types'
import type { EncryptionState } from '@legacy/features/chat/encryptionGate'

/** 單則訊息的表情 chips（emoji、數量、我是否按過）。 */
export function reactionChipsFor(
  reactions: ReactionMap,
  messageId: string,
  myMeshId: string,
): Array<{ emoji: string; count: number; mine: boolean }> {
  const byEmoji = reactions[messageId]
  if (!byEmoji) return []
  return Object.entries(byEmoji).map(([emoji, froms]) => ({
    emoji, count: froms.length, mine: froms.includes(myMeshId),
  }))
}

/** 只在自己訊息下顯示：已讀人數（3+ 人房「已讀 N」；2 人房對方讀過即「已讀」）。 */
export function readReceiptTextFor(
  readState: ReadState,
  msg: ChatMessage,
  myMeshId: string,
  memberCount: number,
): string {
  if (!myMeshId) return ''
  const n = readCount(readState, orderKeyOf(msg), myMeshId) // author=我 → 自動排除自己
  if (n <= 0) return ''
  return Math.max(0, memberCount - 1) > 1 ? `已讀 ${n}` : '已讀'
}

/** 加密狀態 → 頂欄標籤（ADR-0026 R2 fail-visible）。 */
export function e2eeLabelFor(state: EncryptionState): string {
  return state === 'encrypted' ? '端對端加密'
    : state === 'exchanging' ? '金鑰交換中…'
    : '未加密（此房無法端對端加密）'
}
