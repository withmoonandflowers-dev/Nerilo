<script setup lang="ts">
/**
 * neo 主題展示頁（聊天 × 遊戲整合版面，mock 資料、零 Firebase）
 * 用途：設計驗收截圖、對外 demo 開場。真實頁面在 /chat/[roomId]。
 */
const { theme, setTheme } = useTheme()
onMounted(() => setTheme('neo'))
// 展示頁自帶預覽切換（產品 UI 已無循環鈕，Spec 006 T1）
const PREVIEW_ORDER = ['neo', 'light', 'dark'] as const
const previewCycle = () =>
  setTheme(PREVIEW_ORDER[(PREVIEW_ORDER.indexOf(theme.value as typeof PREVIEW_ORDER[number]) + 1) % PREVIEW_ORDER.length]!)

interface MockMsg {
  id: number
  mine: boolean
  text: string
  time: string
  tail?: boolean
}
const msgs: MockMsg[] = [
  { id: 1, mine: false, text: '今晚要不要來一局？', time: '9:41 PM' },
  { id: 2, mine: false, text: '輸的請喝手搖 ✧', time: '9:41 PM', tail: true },
  { id: 3, mine: true, text: '來啊，誰怕誰', time: '9:42 PM' },
  { id: 4, mine: true, text: '這訊息走 P2P 直連，端對端加密，伺服器看不到內容', time: '9:42 PM', tail: true },
  { id: 5, mine: false, text: '好啦開始！我先手 🔥', time: '9:43 PM', tail: true },
]
const showGame = ref(true)
</script>

<template>
  <main class="chat neo-demo" :class="{ 'chat--game': showGame }">
    <header class="chat__header">
      <span class="chat__back">‹</span>
      <div class="chat__head-center">
        <h1 class="chat__title">花花 <span class="chat__lock">🔒</span></h1>
        <p class="chat__status chat__status--connected">已連線 · P2P 直連</p>
      </div>
      <div class="chat__head-actions">
        <button type="button" class="chat__action" :title="`主題：${theme}`" @click="previewCycle">◐</button>
        <button type="button" class="chat__action" :class="{ 'chat__action--on': showGame }" @click="showGame = !showGame">🎮</button>
      </div>
    </header>

    <div class="chat__list">
      <div
        v-for="m in msgs"
        :key="m.id"
        class="msg-row"
        :class="[m.mine ? 'msg-row--mine' : 'msg-row--other', { 'msg-row--group-end': m.tail }]"
      >
        <div class="bubble" :class="[m.mine ? 'bubble--mine' : 'bubble--other', { 'bubble--tail': m.tail }]">
          {{ m.text }}
        </div>
        <div v-if="m.tail" class="msg-meta">{{ m.time }}</div>
      </div>
      <div class="msg-row msg-row--other">
        <div class="bubble bubble--other bubble--typing"><span class="dot" /><span class="dot" /><span class="dot" /></div>
      </div>
    </div>

    <Transition name="game">
      <aside v-if="showGame" class="chat__game">
        <TicTacToePanel :bus="null" my-mark="X" self-id="demo" :connected="true" @close="showGame = false" />
      </aside>
    </Transition>

    <footer class="chat__input-bar">
      <textarea class="chat__input" rows="1" placeholder="訊息" aria-label="訊息輸入框" />
      <button type="button" class="chat__send" aria-label="傳送">↑</button>
    </footer>
  </main>
</template>

<style scoped>
/* 與 /chat/[roomId] 同一套 class 語彙的必要基底（scoped 樣式不跨頁，
   neo 皮膚在 main.css 以 [data-theme='neo'] .chat 全域生效於兩處） */
.chat {
  height: 100%;
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}
.chat__header {
  display: flex;
  align-items: center;
  padding: 10px 12px 8px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(20px);
  border-bottom: 0.5px solid var(--separator);
  position: sticky;
  top: 0;
  z-index: 10;
}
.chat__back { width: 36px; font-size: 28px; color: var(--primary); line-height: 1; text-align: center; }
.chat__head-center { flex: 1; text-align: center; min-width: 0; }
.chat__title { margin: 0; font-size: 17px; font-weight: 600; }
.chat__lock { font-size: 12px; }
.chat__status { margin: 1px 0 0; font-size: 12px; color: var(--text-2); }
.chat__status--connected { color: var(--success); }
.chat__head-actions { display: flex; align-items: center; gap: 2px; }
.chat__action {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  color: var(--primary);
  border-radius: 10px;
}
.chat__action--on { background: var(--bubble-other); }

.chat__list {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.msg-row { display: flex; flex-direction: column; max-width: 75%; }
.msg-row--mine { align-self: flex-end; align-items: flex-end; }
.msg-row--other { align-self: flex-start; align-items: flex-start; }
.msg-row--group-end { margin-bottom: 10px; }
.bubble {
  padding: 9px 14px;
  border-radius: var(--r-bubble);
  font-size: 17px;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble--mine { background: var(--primary); color: var(--on-primary); }
.bubble--other { background: var(--bubble-other); color: var(--text); }
.bubble--mine.bubble--tail { border-bottom-right-radius: 4px; }
.bubble--other.bubble--tail { border-bottom-left-radius: 4px; }
.msg-meta { margin-top: 3px; font-size: 11px; color: var(--text-2); }

.bubble--typing { display: flex; gap: 4px; padding: 13px 14px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-2); animation: typing 1.2s infinite; }
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

@media (min-width: 761px) {
  .chat--game {
    margin-right: 328px;
    margin-left: auto;
  }
}
.chat__game {
  position: fixed;
  top: 76px;
  right: 20px;
  width: 288px;
  z-index: 30;
  border-radius: var(--r-card);
  box-shadow: var(--shadow-2);
  backdrop-filter: blur(16px);
}
@media (max-width: 760px) {
  .chat__game { top: auto; right: 12px; left: 12px; bottom: 84px; width: auto; }
}
.game-enter-active, .game-leave-active { transition: all var(--t-mid) var(--spring); }
.game-enter-from, .game-leave-to { opacity: 0; transform: translateY(12px) scale(0.96); }

.chat__input-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px 10px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(20px);
  border-top: 0.5px solid var(--separator);
}
.chat__input {
  flex: 1;
  resize: none;
  border: 1px solid var(--separator);
  border-radius: var(--r-pill);
  background: var(--surface);
  padding: 9px 16px;
  font-size: 17px;
  outline: none;
}
.chat__send {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  flex-shrink: 0;
}
</style>
