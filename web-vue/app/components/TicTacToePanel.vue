<script setup lang="ts">
import type { GameBus } from '~/lib/gameBus'

const props = defineProps<{
  bus: GameBus | null
  isInitiator: boolean
  selfId: string
  /** P2P 活著才可互動；false = 對局暫停（遊戲不走伺服器備援） */
  connected: boolean
}>()
defineEmits<{ close: [] }>()

const { state, myMark, play, restart } = useTicTacToe(
  computed(() => props.bus),
  computed(() => props.isInitiator),
  computed(() => props.selfId)
)

const status = computed(() => {
  if (state.value.winner === 'draw') return '平手'
  if (state.value.winner) return state.value.winner === myMark.value ? '你贏了 ✧' : '對方獲勝'
  return state.value.turn === myMark.value ? `輪到你（${myMark.value}）` : `等待對方（${state.value.turn}）`
})

const cellDisabled = (i: number) =>
  !props.connected ||
  state.value.board[i] !== null ||
  state.value.turn !== myMark.value ||
  state.value.winner !== null
</script>

<template>
  <section class="ttt" aria-label="井字棋">
    <header class="ttt__head">
      <span class="ttt__title">TIC·TAC·TOE</span>
      <span class="ttt__status" data-testid="ttt-status">{{ status }}</span>
      <button type="button" class="ttt__close" aria-label="關閉遊戲" @click="$emit('close')">✕</button>
    </header>

    <div class="ttt__board-wrap">
      <div class="ttt__board" role="grid" aria-label="棋盤">
        <button
          v-for="(cell, i) in state.board"
          :key="i"
          type="button"
          role="gridcell"
          class="ttt__cell"
          :class="{ 'ttt__cell--x': cell === 'X', 'ttt__cell--o': cell === 'O' }"
          :data-testid="`ttt-cell-${i}`"
          :disabled="cellDisabled(i)"
          :aria-label="`第 ${i + 1} 格${cell ? `：${cell}` : ''}`"
          @click="play(i)"
        >
          {{ cell }}
        </button>
      </div>
      <div v-if="!connected" class="ttt__paused" role="status">連線中斷，對局暫停</div>
    </div>

    <button type="button" class="ttt__restart" :disabled="!connected" @click="restart">
      重新開始
    </button>
  </section>
</template>

<style scoped>
.ttt {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--separator);
  border-radius: var(--r-card);
}
.ttt__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ttt__title {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.ttt__status {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--text-2);
}
.ttt__close {
  color: var(--text-3);
  font-size: 14px;
  padding: 4px;
}
.ttt__board-wrap { position: relative; }
.ttt__board {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.ttt__cell {
  aspect-ratio: 1;
  font-size: 30px;
  font-weight: 800;
  color: var(--text);
  background: var(--bubble-other);
  border: 1px solid var(--separator);
  border-radius: 12px;
  transition: transform var(--t-fast) var(--spring), box-shadow var(--t-fast) var(--ease);
}
.ttt__cell:not(:disabled):hover { transform: scale(1.04); }
.ttt__cell:disabled { cursor: default; }
.ttt__paused {
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
  border-radius: 12px;
}
.ttt__restart {
  padding: 10px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  background: var(--bubble-other);
  border: 1px solid var(--separator);
  border-radius: var(--r-btn);
}

/* ── neo 皮膚：X 粉、O 萊姆、標題漸層、hover 光暈 ──────────────────
   Vue scoped 下祖先在組件外（<html data-theme>），整條選擇器必須包進
   :global()，否則尾端被加上 data-v 屬性而永不命中。class 名唯一，全域安全。 */
:global([data-theme='neo'] .ttt__title) {
  background: var(--neo-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
:global([data-theme='neo'] .ttt__cell--x) {
  color: var(--primary);
  text-shadow: 0 0 12px rgba(255, 45, 138, 0.6);
}
:global([data-theme='neo'] .ttt__cell--o) {
  color: var(--neo-lime);
  text-shadow: 0 0 12px rgba(200, 255, 61, 0.5);
}
:global([data-theme='neo'] .ttt__cell:not(:disabled):hover) {
  border-color: var(--neo-violet);
  box-shadow: var(--neo-glow-violet);
}
:global([data-theme='neo'] .ttt__restart:not(:disabled):hover) {
  background: var(--neo-grad-soft);
  border-color: var(--neo-violet);
}
</style>
