<script setup lang="ts">
import type { GameBus } from '~/lib/gameBus'
import { BOARD_SIZE, type Mark } from '@legacy/features/game/gomoku'

const props = defineProps<{
  bus: GameBus | null
  /** 我的棋子；null = 觀戰（不能下、仍渲染雙方落子） */
  myMark: Mark | null
  selfId: string
  /** P2P 活著才可互動；false = 對局暫停（遊戲不走伺服器備援） */
  connected: boolean
}>()
defineEmits<{ close: [] }>()

const { state, play, restart } = useGomoku(
  computed(() => props.bus),
  computed(() => props.myMark),
  computed(() => props.selfId)
)

const markName = (m: 'B' | 'W') => (m === 'B' ? '黑' : '白')
const status = computed(() => {
  if (state.value.winner === 'draw') return '平手'
  if (!props.myMark) {
    if (state.value.winner) return `${markName(state.value.winner)}獲勝`
    return `觀戰中 · 輪到${markName(state.value.turn)}`
  }
  if (state.value.winner) return state.value.winner === props.myMark ? '你贏了 ✧' : '對方獲勝'
  return state.value.turn === props.myMark
    ? `輪到你（${markName(props.myMark)}）`
    : `等待對方（${markName(state.value.turn)}）`
})

const cellDisabled = (i: number) =>
  !props.connected ||
  !props.myMark ||
  state.value.board[i] !== null ||
  state.value.turn !== props.myMark ||
  state.value.winner !== null
</script>

<template>
  <section class="gmk" aria-label="五子棋">
    <header class="gmk__head">
      <span class="gmk__title">GOMOKU · 五子棋</span>
      <span class="gmk__status" data-testid="gmk-status">{{ status }}</span>
      <button type="button" class="gmk__close" aria-label="關閉遊戲" @click="$emit('close')">✕</button>
    </header>

    <div class="gmk__board-wrap">
      <div
        class="gmk__board"
        role="grid"
        aria-label="棋盤"
        :style="{ gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)` }"
      >
        <button
          v-for="(cell, i) in state.board"
          :key="i"
          type="button"
          role="gridcell"
          class="gmk__cell"
          :class="{ 'gmk__cell--b': cell === 'B', 'gmk__cell--w': cell === 'W' }"
          :data-testid="`gmk-cell-${i}`"
          :disabled="cellDisabled(i)"
          :aria-label="`第 ${i + 1} 格${cell ? `：${markName(cell)}` : ''}`"
          @click="play(i)"
        >
          <span v-if="cell" class="gmk__stone"></span>
        </button>
      </div>
      <div v-if="!connected" class="gmk__paused" role="status">連線中斷，對局暫停</div>
    </div>

    <button type="button" class="gmk__restart" :disabled="!connected" @click="restart">
      重新開始
    </button>
  </section>
</template>

<style scoped>
.gmk {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--separator);
  border-radius: var(--r-card);
}
.gmk__head { display: flex; align-items: center; gap: 8px; }
.gmk__title { font-size: 13px; font-weight: 800; letter-spacing: 0.1em; }
.gmk__status { flex: 1; text-align: right; font-size: 12px; color: var(--text-2); }
.gmk__close { color: var(--text-3); font-size: 14px; padding: 4px; }
.gmk__board-wrap { position: relative; }
.gmk__board {
  display: grid;
  gap: 0;
  aspect-ratio: 1;
  background: #d8b36a; /* 棋盤木色，中性 */
  border: 1px solid var(--separator);
  border-radius: 8px;
  padding: 6px;
}
.gmk__cell {
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0.5px solid rgba(60, 40, 10, 0.35); /* 棋盤格線 */
  padding: 0;
  transition: box-shadow var(--t-fast) var(--ease);
}
.gmk__cell:not(:disabled):hover { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.5); }
.gmk__cell:disabled { cursor: default; }
.gmk__stone {
  width: 78%;
  height: 78%;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
.gmk__cell--b .gmk__stone { background: radial-gradient(circle at 35% 30%, #555, #0a0a0a 70%); }
.gmk__cell--w .gmk__stone { background: radial-gradient(circle at 35% 30%, #fff, #cfcfcf 75%); }
.gmk__paused {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 8px;
  font-size: 13px;
  color: var(--text);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(4px);
  border-radius: 8px;
}
.gmk__restart {
  padding: 10px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  background: var(--bubble-other);
  border: 1px solid var(--separator);
  border-radius: var(--r-btn);
}
:global([data-theme='neo'] .gmk__title) {
  background: var(--neo-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
:global([data-theme='neo'] .gmk__cell:not(:disabled):hover) {
  box-shadow: inset 0 0 0 2px var(--neo-violet);
}
</style>
