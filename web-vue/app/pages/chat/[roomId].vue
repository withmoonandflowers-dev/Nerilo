<script setup lang="ts">
import { RoomService } from '@legacy/services/RoomService'
import { sendMessageViaFirestore, subscribeToFirestoreMessages } from '@legacy/services/FirestoreChatFallback'
import type { ChatMessage, ConnectionState, P2PRoom } from '@legacy/types'
import { generateUUID } from '@legacy/utils/uuid'
import { featureLog } from '@legacy/utils/featureLog'
import type { P2PChannelBus } from '@legacy/core/p2p/P2PChannelBus'
import { StarTopologyController } from '~/lib/starTopology'
import { RoomSubscriptionController } from '~/lib/roomSubscription'

type Topology = 'star' | 'mesh'

definePageMeta({ pageTransition: { name: 'slide', mode: 'out-in' } })

const route = useRoute()
const roomId = computed(() => String(route.params.roomId ?? ''))
const { user, loading } = useAuth()
const { error: toastError } = useToast()
const { messages, addMessage, updateMessageStatus } = useChatMessages()

const roomName = ref<string | undefined>(undefined)
const connectionState = ref<ConnectionState>('idle')
const currentTopology = ref<Topology | null>(null)
// ── 遊戲（整合頁：聊天 × 井字棋，2 人星型房）────────────────────────
const showGame = ref(false)
const gameBus = ref<P2PChannelBus | null>(null)
const isRoomOwner = ref(false)
const { theme, cycleTheme } = useTheme()
const themeLabel = computed(
  () => ({ neo: 'NEO', light: '亮', dark: '暗' })[theme.value]
)
const meshNotice = ref(false)
const peerTyping = ref(false)
const inputValue = ref('')
const isNearBottom = ref(true)
const unseenCount = ref(0)

const listEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)

const starTopology = new StarTopologyController()
const roomSubscription = new RoomSubscriptionController()
let migrationInProgress = false
let hasJoinedRoom = false
let fallbackUnsub: (() => void) | null = null
let typingUnsub: (() => void) | null = null
let typingDebounce: ReturnType<typeof setTimeout> | null = null
let initialized = false
let disposed = false

const statusText = computed(() => {
  switch (connectionState.value) {
    case 'connected':
      return currentTopology.value === 'star' ? '已連線 · P2P 直連' : '已連線'
    case 'connecting':
      return '連線中…'
    case 'failed':
      return '連線失敗'
    case 'closed':
      return '連線已中斷'
    default:
      return meshNotice.value ? '經伺服器備援通道' : '準備中…'
  }
})

/** decideArchitecture — 對齊 React 版 useP2PArchitecture：3+ 人或明確標記 → mesh */
function decideTopology(room: P2PRoom, effectiveCount: number): Topology {
  if (room.topology === 'mesh') return 'mesh'
  return effectiveCount >= 3 ? 'mesh' : 'star'
}

function setConnectionState(state: ConnectionState) {
  connectionState.value = state
}

function onIncomingMessage(msg: ChatMessage) {
  addMessage(msg)
}

async function initializeP2P(room: P2PRoom, effectiveParticipantCount?: number) {
  if (migrationInProgress) return
  migrationInProgress = true
  try {
    const uid = user.value!.uid
    const effectiveCount = effectiveParticipantCount ?? room.participants.length
    if (room.status !== 'open' || effectiveCount < 2) return

    const decision = decideTopology(room, effectiveCount)
    if (currentTopology.value === decision) return

    featureLog('chat', 'architecture_decided', { roomId: roomId.value, type: decision, from: currentTopology.value })

    if (decision === 'mesh') {
      // Vue 版 v1 尚未移植 mesh（MeshGossipManager 接線排下一輪）：
      // 3+ 人房間走 Firestore 備援通道，誠實標示於 UI。
      starTopology.cleanup()
      currentTopology.value = 'mesh'
      meshNotice.value = true
      connectionState.value = 'idle'
      return
    }

    if (currentTopology.value === null) {
      const isInitiator = room.ownerUid === uid
      isRoomOwner.value = isInitiator
      await starTopology.initialize(roomId.value, uid, isInitiator, setConnectionState, onIncomingMessage)
      currentTopology.value = 'star'
      // 遊戲騎同一條 bus（ns:'ttt'）；連線建立後 bus 才存在
      gameBus.value = starTopology.getChannelBus()
      typingUnsub = starTopology.onTyping(({ userId, isTyping }) => {
        if (userId !== uid) peerTyping.value = isTyping
      })
    }
  } catch (e) {
    console.error('[chat] initializeP2P failed', e)
    connectionState.value = 'failed'
  } finally {
    migrationInProgress = false
  }
}

async function init() {
  const uid = user.value!.uid
  featureLog('chat', 'init', { roomId: roomId.value, uid })
  try {
    // 1-2. 房間存在且未關閉
    const room = await RoomService.getRoom(roomId.value)
    if (disposed) return
    if (!room) return navigateTo('/dashboard', { replace: true })
    roomName.value = room.roomName
    if (room.status === 'closed') return navigateTo('/dashboard', { replace: true })

    // 3. 加入房間
    try {
      await RoomService.joinRoom(roomId.value, uid)
      if (disposed) return
      featureLog('chat', 'room_joined', { roomId: roomId.value, uid })
      hasJoinedRoom = true
      startFallbackSubscription()

      await new Promise((r) => setTimeout(r, 500))
      if (disposed) return
      const after = await RoomService.getRoom(roomId.value, true)
      if (disposed) return
      if (!after) return navigateTo('/dashboard', { replace: true })
      if (after.status === 'waiting' && after.participants.length < 2) {
        return navigateTo(`/waiting/${roomId.value}`, { replace: true })
      }
    } catch (e) {
      if (e instanceof Error && e.message === '房間已關閉') {
        return navigateTo('/dashboard', { replace: true })
      }
      throw e
    }

    // 4-5. 訂閱房間變化 → 觸發 P2P 初始化
    await roomSubscription.subscribe(roomId.value, {
      onRoomClosed: () => navigateTo('/dashboard', { replace: true }),
      onRoomWaiting: () => navigateTo(`/waiting/${roomId.value}`, { replace: true }),
      onRoomOpen: (openRoom, effectiveCount) => initializeP2P(openRoom, effectiveCount),
      onRoomNotFound: () => navigateTo('/dashboard', { replace: true }),
    })
    if (disposed) return

    // 6. 初始狀態已 open → 立即初始化（open 至少代表曾有 2 人）
    const initial = await RoomService.getRoom(roomId.value, true)
    if (disposed) return
    if (initial && initial.status === 'open') {
      await initializeP2P(initial, Math.max(initial.participants.length, 2))
    }
  } catch (e) {
    console.error('[chat] init failed', e)
    connectionState.value = 'failed'
  }
}

function startFallbackSubscription() {
  if (fallbackUnsub || !user.value) return
  const uid = user.value.uid
  // Firestore 備援：P2P 未連線時對方經備援送的訊息也能顯示；到訊當下再解析金鑰。
  // 自己的訊息（密文或明文）一律略過——本機已有樂觀回顯，且備援端另生 messageId 會造成重複。
  fallbackUnsub = subscribeToFirestoreMessages(roomId.value, (msg) => {
    if (msg.from.split('/')[0] === uid) return
    addMessage(msg)
  }, {
    localUid: uid,
    decrypt: (payload: unknown, senderId: string) => {
      const chatService = starTopology.getChatService()
      if (!chatService) return Promise.reject(new Error('ChatService not ready'))
      return chatService.decryptFromFallback(payload as never, senderId)
    },
  })
}

watchEffect(() => {
  if (loading.value || !user.value || !roomId.value || initialized) return
  initialized = true
  init()
})

onUnmounted(() => {
  disposed = true
  roomSubscription.unsubscribe()
  typingUnsub?.()
  fallbackUnsub?.()
  starTopology.cleanup()
  if (roomId.value && user.value) {
    RoomService.leaveRoom(roomId.value, user.value.uid).catch((e: unknown) =>
      console.error('[chat] leaveRoom failed', e)
    )
  }
})

// ── 傳送 ────────────────────────────────────────────────────────────────
async function sendMessage(content: string, existingMessageId?: string) {
  if (!user.value || !roomId.value) return
  const uid = user.value.uid
  const tempId = existingMessageId || generateUUID()
  if (!existingMessageId) {
    addMessage({
      messageId: tempId,
      from: uid,
      content,
      timestamp: Date.now(),
      deliveryStatus: 'sending',
    })
  } else {
    updateMessageStatus(tempId, 'sending')
  }

  try {
    if (connectionState.value === 'connected' && currentTopology.value === 'star') {
      await starTopology.sendMessage(content, tempId)
      featureLog('chat', 'message_sent', { roomId: roomId.value, channel: 'p2p_star' })
    } else if (currentTopology.value === 'star' || currentTopology.value === null) {
      // ADR-0004：星型房的備援一律密文；金鑰未就緒時擲錯（訊息標失敗、可重送）
      const chatService = starTopology.getChatService()
      if (!chatService) {
        throw new Error('E2EE 金鑰尚未建立（P2P 交換未完成），無法經備援通道傳送')
      }
      const encrypted = await chatService.encryptForFallback(content)
      await sendMessageViaFirestore(roomId.value, uid, { encrypted })
      featureLog('chat', 'message_sent', { roomId: roomId.value, channel: 'firestore_fallback' })
    } else {
      // mesh 房間尚未支援 E2EE（誠實標示於 UI），備援維持明文
      await sendMessageViaFirestore(roomId.value, uid, { content })
      featureLog('chat', 'message_sent', { roomId: roomId.value, channel: 'firestore_fallback' })
    }
    updateMessageStatus(tempId, 'sent')
    setTimeout(() => updateMessageStatus(tempId, 'delivered'), 1500)
  } catch (e) {
    console.error('[chat] send failed', e)
    updateMessageStatus(tempId, 'failed')
    if (e instanceof Error && e.message.includes('金鑰')) toastError(e.message)
  }
}

async function handleSend() {
  const content = inputValue.value.trim()
  if (!content) return
  inputValue.value = ''
  if (textareaEl.value) textareaEl.value.style.height = 'auto'
  emitTyping(false)
  await sendMessage(content)
}

function handleResend(msg: ChatMessage) {
  sendMessage(msg.content, msg.messageId)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function autoGrow() {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  emitTyping(true)
}

function emitTyping(isTyping: boolean) {
  starTopology.sendTyping(isTyping)
  if (typingDebounce) clearTimeout(typingDebounce)
  if (isTyping) {
    typingDebounce = setTimeout(() => starTopology.sendTyping(false), 2500)
  }
}

// ── 顯示 ────────────────────────────────────────────────────────────────
const senderUid = (m: ChatMessage) => m.from.split('/')[0]
const isMine = (m: ChatMessage) => !!user.value && senderUid(m) === user.value.uid

interface Row {
  msg: ChatMessage
  mine: boolean
  groupStart: boolean
  groupEnd: boolean
  showTime: boolean
}

const rows = computed<Row[]>(() => {
  const list = messages.value.filter((m) => !m.deleted)
  return list.map((msg, i) => {
    const prev = list[i - 1]
    const next = list[i + 1]
    const samePrev = !!prev && senderUid(prev) === senderUid(msg) && msg.timestamp - prev.timestamp < 60_000
    const sameNext = !!next && senderUid(next) === senderUid(msg) && next.timestamp - msg.timestamp < 60_000
    return {
      msg,
      mine: isMine(msg),
      groupStart: !samePrev,
      groupEnd: !sameNext,
      showTime: !sameNext,
    }
  })
})

const lastMineId = computed(() => {
  const mine = rows.value.filter((r) => r.mine)
  return mine.length ? mine[mine.length - 1]!.msg.messageId : null
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('zh-TW', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (sameDay) return time
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  return `${d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })} ${time}`
}

const statusLabel: Record<string, string> = {
  sending: '傳送中…',
  sent: '已送出',
  delivered: '已送達',
  failed: '傳送失敗',
}

function onScroll() {
  const el = listEl.value
  if (!el) return
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  if (isNearBottom.value) unseenCount.value = 0
}

function scrollToBottom(smooth = true) {
  nextTick(() => {
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    unseenCount.value = 0
  })
}

watch(
  () => messages.value.length,
  (len, prevLen) => {
    if (len <= prevLen) return
    const last = messages.value[len - 1]
    if (isNearBottom.value || (last && isMine(last))) scrollToBottom()
    else unseenCount.value += len - prevLen
  }
)

// 非房主側的 ChannelBus 在遠端 DataChannel 到達後才存在——連上時再取一次
watch(connectionState, (s) => {
  if (s === 'connected' && currentTopology.value === 'star') {
    gameBus.value = starTopology.getChannelBus()
  }
})

function retryConnection() {
  connectionState.value = 'connecting'
  currentTopology.value = null
  starTopology.cleanup()
  RoomService.getRoom(roomId.value, true).then((room) => {
    if (room && room.status === 'open') initializeP2P(room, Math.max(room.participants.length, 2))
  })
}

async function leaveRoom() {
  navigateTo('/dashboard')
}
</script>

<template>
  <main class="chat" :class="{ 'chat--game': showGame && currentTopology === 'star' }">
    <header class="chat__header">
      <button type="button" class="chat__back" aria-label="離開房間" @click="leaveRoom">‹</button>
      <div class="chat__head-center">
        <h1 class="chat__title">
          {{ roomName ?? '聊天室' }}
          <span v-if="currentTopology === 'star'" class="chat__lock" title="端對端加密">🔒</span>
        </h1>
        <p class="chat__status" :class="`chat__status--${connectionState}`">{{ statusText }}</p>
      </div>
      <div class="chat__head-actions">
        <button
          type="button"
          class="chat__action"
          :aria-label="`切換主題（目前 ${themeLabel}）`"
          :title="`主題：${themeLabel}`"
          @click="cycleTheme"
        >◐</button>
        <button
          v-if="currentTopology === 'star'"
          type="button"
          class="chat__action"
          :class="{ 'chat__action--on': showGame }"
          aria-label="開啟遊戲"
          title="井字棋"
          @click="showGame = !showGame"
        >🎮</button>
      </div>
    </header>

    <div v-if="connectionState === 'failed'" class="chat__banner">
      <span>連線中斷了</span>
      <button type="button" @click="retryConnection">重新連線</button>
    </div>
    <div v-else-if="meshNotice" class="chat__banner chat__banner--info">
      <span>3 人以上房間的 P2P 連線即將推出，目前經伺服器備援傳送（未端對端加密）</span>
    </div>

    <div ref="listEl" class="chat__list" @scroll="onScroll">
      <TransitionGroup name="msg">
        <div v-for="row in rows" :key="row.msg.messageId" class="msg-row"
             :class="[row.mine ? 'msg-row--mine' : 'msg-row--other', { 'msg-row--group-end': row.groupEnd }]">
          <div class="bubble" :class="[row.mine ? 'bubble--mine' : 'bubble--other', { 'bubble--tail': row.groupEnd }]">
            {{ row.msg.content }}
          </div>
          <div v-if="row.showTime" class="msg-meta">
            <span>{{ formatTime(row.msg.timestamp) }}</span>
          </div>
          <div v-if="row.mine && row.msg.deliveryStatus && (row.msg.messageId === lastMineId || row.msg.deliveryStatus === 'failed')"
               class="msg-status" :class="{ 'msg-status--failed': row.msg.deliveryStatus === 'failed' }">
            <template v-if="row.msg.deliveryStatus === 'failed'">
              傳送失敗 ·
              <button type="button" class="msg-status__retry" @click="handleResend(row.msg)">重新傳送</button>
            </template>
            <template v-else>{{ statusLabel[row.msg.deliveryStatus] }}</template>
          </div>
        </div>
      </TransitionGroup>

      <div v-if="peerTyping" class="msg-row msg-row--other">
        <div class="bubble bubble--other bubble--typing">
          <span class="dot" /><span class="dot" /><span class="dot" />
        </div>
      </div>
    </div>

    <Transition name="pill">
      <button v-if="unseenCount > 0" type="button" class="chat__new-pill" @click="scrollToBottom()">
        ↓ {{ unseenCount }} 則新訊息
      </button>
    </Transition>

    <!-- 井字棋：桌面右側玻璃卡、窄幕底部抽屜；斷線由面板顯示對局暫停 -->
    <Transition name="game">
      <aside v-if="showGame && currentTopology === 'star' && user" class="chat__game">
        <TicTacToePanel
          :bus="gameBus"
          :is-initiator="isRoomOwner"
          :self-id="user.uid"
          :connected="connectionState === 'connected'"
          @close="showGame = false"
        />
      </aside>
    </Transition>

    <footer class="chat__input-bar">
      <textarea
        ref="textareaEl"
        v-model="inputValue"
        class="chat__input"
        rows="1"
        placeholder="訊息"
        aria-label="訊息輸入框"
        @input="autoGrow"
        @keydown="handleKeydown"
      />
      <Transition name="send">
        <button v-if="inputValue.trim()" type="button" class="chat__send" aria-label="傳送" @click="handleSend">↑</button>
      </Transition>
    </footer>
  </main>
</template>

<style scoped>
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
  padding: calc(env(safe-area-inset-top, 0px) + 8px) 12px 8px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(20px);
  border-bottom: 0.5px solid var(--separator);
  position: sticky;
  top: 0;
  z-index: 10;
}
.chat__back {
  width: 36px;
  font-size: 28px;
  color: var(--primary);
  line-height: 1;
}
.chat__head-center { flex: 1; text-align: center; min-width: 0; }
.chat__head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.chat__action {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  color: var(--primary);
  border-radius: 10px;
  transition: background var(--t-fast) var(--ease);
}
.chat__action:hover { background: var(--bubble-other); }
.chat__action--on { background: var(--bubble-other); }
.chat__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat__lock { font-size: 12px; }
.chat__status { margin: 1px 0 0; font-size: 12px; color: var(--text-2); }
.chat__status--connected { color: var(--success); }
.chat__status--failed { color: var(--danger); }

.chat__banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 16px;
  background: #FFF3CD;
  color: #856404;
  font-size: 14px;
}
.chat__banner button {
  color: var(--primary);
  font-weight: 600;
  font-size: 14px;
}
.chat__banner--info { background: #E5F1FF; color: #1D5D9B; }

.chat__list {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.msg-row {
  display: flex;
  flex-direction: column;
  max-width: 75%;
}
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
/* iMessage 尾巴方向感：群組最後一則收窄該側圓角 */
.bubble--mine.bubble--tail { border-bottom-right-radius: 4px; }
.bubble--other.bubble--tail { border-bottom-left-radius: 4px; }

.msg-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-2);
}
.msg-status {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-2);
}
.msg-status--failed { color: var(--danger); }
.msg-status__retry {
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
}

.bubble--typing {
  display: flex;
  gap: 4px;
  padding: 13px 14px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-2);
  animation: typing 1.2s infinite;
}
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

.chat__new-pill {
  position: absolute;
  bottom: 84px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  background: var(--primary);
  color: #fff;
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 600;
  box-shadow: var(--shadow-2);
}

.chat__input-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px calc(env(safe-area-inset-bottom, 0px) + 10px);
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
  line-height: 1.35;
  outline: none;
  max-height: 96px;
}
.chat__input:focus { border-color: var(--primary); }
.chat__send {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  flex-shrink: 0;
  transition: transform var(--t-fast) var(--spring);
}
.chat__send:active { transform: scale(0.9); }

/* 面板開啟時聊天欄讓位（寬幕），避免浮卡壓住泡泡與時間戳 */
@media (min-width: 761px) {
  .chat--game {
    margin-right: 328px;
    margin-left: auto;
  }
}

/* 遊戲面板：寬幕＝右側浮卡（玻璃），窄幕＝底部抽屜（輸入列上方） */
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
  .chat__game {
    top: auto;
    right: 12px;
    left: 12px;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 76px);
    width: auto;
  }
}
.game-enter-active, .game-leave-active { transition: all var(--t-mid) var(--spring); }
.game-enter-from, .game-leave-to { opacity: 0; transform: translateY(12px) scale(0.96); }

.msg-enter-active { transition: all var(--t-mid) var(--spring); }
.msg-enter-from { opacity: 0; transform: translateY(10px) scale(0.9); }
.send-enter-active, .pill-enter-active { transition: all var(--t-fast) var(--spring); }
.send-enter-from, .pill-enter-from { opacity: 0; transform: scale(0.5); }
.send-leave-active, .pill-leave-active { transition: all var(--t-fast) var(--ease); }
.send-leave-to, .pill-leave-to { opacity: 0; transform: scale(0.5); }
.pill-leave-to { transform: translateX(-50%) scale(0.8); }
.pill-enter-from { transform: translateX(-50%) scale(0.8); }
</style>
