/**
 * GameBus — 遊戲事件傳輸的最小介面（P2-③ Phase 2）。
 *
 * useTicTacToe 只需要 send / subscribe 兩個方法。抽成介面後，星型的
 * P2PChannelBus（結構相容，直接滿足）與 mesh 的 MeshGameBus（見 meshGameBus.ts）
 * 都能餵給同一份遊戲邏輯——2 人房從 star 切 mesh（Phase 3）時遊戲零回退。
 */
import type { P2PEnvelope } from '@legacy/types'

export interface GameBus {
  send(envelope: P2PEnvelope): Promise<void>
  subscribe(namespace: string, handler: (envelope: P2PEnvelope) => void | Promise<void>): () => void
}
