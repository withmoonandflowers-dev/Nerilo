/**
 * MeshGameBus — 把 TicTacToe 的 GameBus 介面接到 mesh gossip 管線（P2-③ Phase 2）。
 *
 * send  → MeshChatService.sendGameEnvelope（channel:'game'，可靠廣播 + 對帳）
 * subscribe(ns) → 訂閱 channel:'game' 的 envelope，過濾 env.ns 後轉交（TicTacToe 只用 'ttt'）
 *
 * 語義對齊星型 P2PChannelBus：
 *  - 不回吐自送（mesh onMessage 不回吐本機訊息；useTicTacToe 另以 env.from 過濾）。
 *  - 回合制事件走可靠管線 → MOVE/RESTART 不掉（比星型 lossy bus 更穩）。
 */
import type { P2PEnvelope } from '@legacy/types'
import type { MeshChatService } from '@legacy/features/chat/MeshChatService'
import type { GameBus } from './gameBus'

export class MeshGameBus implements GameBus {
  constructor(private readonly mesh: MeshChatService) {}

  async send(envelope: P2PEnvelope): Promise<void> {
    await this.mesh.sendGameEnvelope(envelope)
  }

  subscribe(
    namespace: string,
    handler: (envelope: P2PEnvelope) => void | Promise<void>
  ): () => void {
    return this.mesh.onGameMessage((env) => {
      if (env.ns === namespace) void handler(env)
    })
  }
}
