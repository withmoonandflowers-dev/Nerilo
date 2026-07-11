/**
 * 五子棋 × Nerilo bus（協議與井字棋 useTicTacToe 同構，換 ns:'gomoku' + gomoku 邏輯）
 *
 * 事件式（game-integration-spec §2）：MOVE / RESTART / SYNC_REQ / SYNC_STATE 騎 GameBus。
 * payload 一律至少 {}（bus 會丟棄 payload undefined 的 envelope）。純邏輯共用 @legacy。
 * 棋子：initiator = 'B'（黑先）/非 initiator = 'W'。
 */
import type { Ref } from 'vue'
import type { GameBus } from '~/lib/gameBus'
import type { P2PEnvelope } from '@legacy/types'
import { generateUUID } from '@legacy/utils/uuid'
import { logger } from '@legacy/utils/logger'
import {
  applyMove,
  initialState,
  moveCount,
  sanitizeState,
  type Mark,
  type GomokuState,
} from '@legacy/features/game/gomoku'

const GAME_NS = 'gomoku'

export function useGomoku(bus: Ref<GameBus | null>, isInitiator: Ref<boolean>, selfId: Ref<string>) {
  const state = ref<GomokuState>(initialState())
  const myMark = computed<Mark>(() => (isInitiator.value ? 'B' : 'W'))

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
      logger.warn('[useGomoku] send failed', { type, error })
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
          if (typeof cell !== 'number' || (mark !== 'B' && mark !== 'W')) return
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
