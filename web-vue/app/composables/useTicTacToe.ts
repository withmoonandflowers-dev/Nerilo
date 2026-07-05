/**
 * 井字棋 × Nerilo bus（Vue 版；協議與 React 版 src/features/game/useTicTacToe.ts 一致）
 *
 * 事件式（game-integration-spec §2）：ns:'ttt' 騎 P2PChannelBus。
 * MOVE / RESTART / SYNC_REQ / SYNC_STATE；payload 一律至少 {}（bus 驗證
 * 會丟棄 payload undefined 的 envelope——已踩過的坑，見 transport-contract-M4）。
 * 純邏輯（applyMove/sanitizeState/moveCount）與 React 版共用 @legacy 同一份。
 */
import type { Ref } from 'vue'
import type { P2PChannelBus } from '@legacy/core/p2p/P2PChannelBus'
import type { P2PEnvelope } from '@legacy/types'
import { generateUUID } from '@legacy/utils/uuid'
import { logger } from '@legacy/utils/logger'
import {
  applyMove,
  initialState,
  moveCount,
  sanitizeState,
  type Mark,
  type TicTacToeState,
} from '@legacy/features/game/ticTacToe'

const GAME_NS = 'ttt'

export function useTicTacToe(
  bus: Ref<P2PChannelBus | null>,
  isInitiator: Ref<boolean>,
  selfId: Ref<string>
) {
  const state = ref<TicTacToeState>(initialState())
  const myMark = computed<Mark>(() => (isInitiator.value ? 'X' : 'O'))

  function send(type: 'MOVE' | 'RESTART' | 'SYNC_REQ' | 'SYNC_STATE', payload?: unknown) {
    const b = bus.value
    if (!b) return
    b.send({
      v: 1,
      ns: GAME_NS,
      type,
      id: generateUUID(),
      ts: Date.now(),
      from: selfId.value,
      payload: payload ?? {},
    } as P2PEnvelope).catch((error) => {
      // 送失敗 = 連線斷；UI 由 connectionState 進暫停態。warn 保留診斷線索。
      logger.warn('[useTicTacToe] send failed', { type, error })
    })
  }

  let unsubscribe: (() => void) | null = null
  watch(
    bus,
    (b) => {
      unsubscribe?.()
      unsubscribe = null
      if (!b) return
      unsubscribe = b.subscribe(GAME_NS, async (env) => {
        if (env.from === selfId.value) return
        if (env.type === 'MOVE') {
          const { cell, mark } = (env.payload ?? {}) as { cell?: number; mark?: Mark }
          if (typeof cell !== 'number' || (mark !== 'X' && mark !== 'O')) return
          if (mark === myMark.value) return // 對端不能下我方的棋
          state.value = applyMove(state.value, cell, mark)
        } else if (env.type === 'RESTART') {
          state.value = initialState()
        } else if (env.type === 'SYNC_REQ') {
          send('SYNC_STATE', state.value)
        } else if (env.type === 'SYNC_STATE') {
          const incoming = sanitizeState(env.payload)
          if (incoming && moveCount(incoming) > moveCount(state.value)) state.value = incoming
        }
      })
      send('SYNC_REQ') // 開面板/重連即對齊盤面
    },
    { immediate: true }
  )
  onUnmounted(() => unsubscribe?.())

  function play(cell: number) {
    const s = state.value
    if (s.turn !== myMark.value || s.winner !== null || s.board[cell] !== null) return
    const next = applyMove(s, cell, myMark.value)
    if (next !== s) {
      state.value = next
      send('MOVE', { cell, mark: myMark.value })
    }
  }

  function restart() {
    state.value = initialState()
    send('RESTART')
  }

  return { state: readonly(state), myMark, play, restart }
}
