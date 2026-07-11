<script setup lang="ts">
import { RoomService } from '@legacy/services/RoomService'
import { sendMessageViaFirestore, subscribeToFirestoreMessages } from '@legacy/services/FirestoreChatFallback'
import type { ChatMessage, ConnectionState, P2PRoom } from '@legacy/types'
import { generateUUID } from '@legacy/utils/uuid'
import { featureLog } from '@legacy/utils/featureLog'
import { MeshChatService } from '@legacy/features/chat/MeshChatService'
import { MeshGameBus } from '~/lib/meshGameBus'
import type { GameBus } from '~/lib/gameBus'
import { RoomSubscriptionController } from '~/lib/roomSubscription'

// star 特例已退役（ADR-0023 P2-③）；保留具名型別供 currentTopology 語義清楚。
type Topology = 'mesh'

definePageMeta({ pageTransition: { name: 'slide', mode: 'out-in' } })

const route = useRoute()
const roomId = computed(() => String(route.params.roomId ?? ''))
const { user, loading } = useAuth()
const { error: toastError } = useToast()
const { messages, addMessage, updateMessageStatus } = useChatMessages()

const roomName = ref<string | undefined>(undefined)
const connectionState = ref<ConnectionState>('idle')
const currentTopology = ref<Topology | null>(null)
// ── 遊戲（整合頁：聊天 × 井字棋，2 人房；星型或 mesh 皆可，見 MeshGameBus）──
const showGame = ref(false)
const selectedGame = ref<'ttt' | 'gomoku'>('ttt') // 房內小遊戲選擇（同一條 mesh game 通道）
const gameBus = ref<GameBus | null>(null)
const isRoomOwner = ref(false)
/** 房間成員數（reactive，供模板閘控：遊戲僅 2 人房、mesh 橫幅僅 3+ 人房） */
const memberCount = ref(0)
const { theme, cycleTheme } = useTheme()
const themeLabel = computed(
  () => ({ neo: 'NEO', light: '亮', dark: '暗' })[theme.value]
)
const peerTyping = ref(false)
const inputValue = ref('')
const isNearBottom = ref(true)
const unseenCount = ref(0)

const listEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)

const roomSubscription = new RoomSubscriptionController()
// mesh（3-5 人）：直接複用零框架依賴的 MeshChatService（gossip + anti-entropy 對帳）
let meshChat: MeshChatService | null = null
let meshStateInterval: ReturnType<typeof setInterval> | null = null
/** 房間文件的最新參與者數（真相來源），mesh 覆蓋不足時的備援橋接條件用 */
let participantCount = 0
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
      return '已連線'
    case 'connecting':
      return '連線中…'
    case 'failed':
      return '連線失敗'
    case 'closed':
      return '連線已中斷'
    default:
      return '準備中…'
  }
})

// 在房內收到訊息即已讀（節流 5s，metadata 寫入）
let lastReadWriteAt = 0
function touchRead() {
  if (!user.value || !roomId.value) return
  const now = Date.now()
  if (now - lastReadWriteAt < 5_000) return
  lastReadWriteAt = now
  RoomService.markRead(roomId.value, user.value.uid).catch(() => {})
}

// 送訊後 bump 房間活躍度（節流 10s；只寫 lastActiveAt/ttl metadata，
// 讓其他成員的列表排序/未讀點亮，內容不經伺服器）
let lastBumpAt = 0
function touchActivity() {
  if (!roomId.value) return
  const now = Date.now()
  if (now - lastBumpAt < 10_000) return
  lastBumpAt = now
  RoomService.bumpActivity(roomId.value).catch(() => {})
}

async function initializeP2P(room: P2PRoom, effectiveParticipantCount?: number) {
  if (migrationInProgress) return
  migrationInProgress = true
  try {
    const uid = user.value!.uid
    const effectiveCount = effectiveParticipantCount ?? room.participants.length
    participantCount = Math.max(participantCount, effectiveCount)
    memberCount.value = participantCount
    if (room.status !== 'open' || effectiveCount < 2) return

    if (currentTopology.value === 'mesh') return // 已建立，勿重複初始化

    featureLog('chat', 'architecture_decided', { roomId: roomId.value, type: 'mesh', from: currentTopology.value })

    // ADR-0023 P2-③：一律走 gossip 複寫日誌（star 退役）。複用 @legacy MeshChatService
    // （gossip + seq anti-entropy 對帳，恰好一次見 docs/QA-REPORT-chat.md 第三輪）。
    currentTopology.value = 'mesh'
    connectionState.value = 'connecting'
    isRoomOwner.value = room.ownerUid === uid // 房主＝井字棋 X；遊戲騎 mesh gossip（MeshGameBus）
    const svc = new MeshChatService(roomId.value, uid)
    await svc.initialize()
    if (disposed) {
      await svc.cleanup()
      return
    }
    meshChat = svc
    gameBus.value = new MeshGameBus(svc)
    svc.onMessage((msg) => addMessage(msg))
    // typing：mesh 只收到 peer 的信號（不回吐自送），直接反映到「輸入中…」
    typingUnsub = svc.onTyping(({ isTyping }) => { peerTyping.value = isTyping })
    svc.loadHistory().then((history) => history.forEach((m) => addMessage(m))).catch(() => {})
    // 連線狀態輪詢（對齊 React useMeshTopology：mesh 內部無 push 事件）
    meshStateInterval = setInterval(() => {
      if (!meshChat) return
      const s = meshChat.getConnectionState()
      const mapped: ConnectionState = s === 'idle' ? 'connecting' : s
      if (mapped !== connectionState.value) connectionState.value = mapped
    }, 2000)
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
      touchRead() // 進房即已讀

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
      // 2 人房已一律 mesh（P2-③）：備援密文用房間金鑰（keyx）解，非星型 sender key。
      if (!meshChat) return Promise.reject(new Error('mesh chat not ready'))
      return meshChat.decryptFromFallback(payload as never, senderId)
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
  if (meshStateInterval) clearInterval(meshStateInterval)
  meshChat?.cleanup().catch(() => {})
  meshChat = null
  credits.stopEarning()
  // 持久聊天室（2026-07-05 產品決策）：跳出畫面「不」等於離開聊天室——
  // 不再 leaveRoom；退出/刪除由列表的動作選單明確操作。離頁補一次已讀。
  if (roomId.value && user.value) {
    RoomService.markRead(roomId.value, user.value.uid).catch(() => {})
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
    // ADR-0023 P2-③：2 人房一律走 gossip 複寫日誌（star 退役）。
    if (!meshChat) {
      throw new Error('連線建立中，請稍候再送')
    }
    // store-first：先入複寫日誌（此刻沒連上也會由 anti-entropy 補送），liveness 不綁當下連線。
    await meshChat.sendMessage(content, tempId)
    featureLog('chat', 'message_sent', { roomId: roomId.value, channel: 'p2p_mesh' })
    // 覆蓋不足（有成員不在 mesh，多半離線/連線中）→ 加密備援橋接，讓其收得到。
    // 用房間金鑰（keyx）加密；無金鑰則「不送明文」——靠 mesh anti-entropy 補齊，
    // 不再明文洩漏到 Firestore（P2-③ 收尾；星型舊路徑的密文備援等價）。
    const coverage = meshChat.getMeshCoverage()
    const expectedPeers = participantCount - 1
    if (expectedPeers > 0 && coverage.connected < expectedPeers) {
      const encrypted = await meshChat.encryptForFallback(content)
      if (encrypted) {
        await sendMessageViaFirestore(roomId.value, uid, { encrypted }, tempId)
        featureLog('chat', 'message_sent', { roomId: roomId.value, channel: 'firestore_bridge' })
      } else {
        featureLog('chat', 'fallback_skipped_no_key', { roomId: roomId.value })
      }
    }
    updateMessageStatus(tempId, 'sent')
    setTimeout(() => updateMessageStatus(tempId, 'delivered'), 1500)
    touchActivity()
    touchRead()
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

function sendTypingSignal(isTyping: boolean) {
  // mesh gossip presence 通道（lossy）；star 退役後無其他路徑。
  meshChat?.sendTyping(isTyping)
}

function emitTyping(isTyping: boolean) {
  sendTypingSignal(isTyping)
  if (typingDebounce) clearTimeout(typingDebounce)
  if (isTyping) {
    typingDebounce = setTimeout(() => sendTypingSignal(false), 2500)
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

// 在線累積點數（ADR-0011）：只在實際 connected 時賺（誠實原則，同 React 版）
const credits = useCredits()
watch(connectionState, (s) => {
  if (s === 'connected') credits.startEarning()
  else credits.stopEarning()
})

function retryConnection() {
  connectionState.value = 'connecting'
  currentTopology.value = null
  // mesh 收乾淨再重建，否則舊 MeshChatService 續跑（interval/連線洩漏）
  if (meshStateInterval) { clearInterval(meshStateInterval); meshStateInterval = null }
  meshChat?.cleanup().catch(() => {})
  meshChat = null
  gameBus.value = null
  RoomService.getRoom(roomId.value, true).then((room) => {
    if (room && room.status === 'open') initializeP2P(room, Math.max(room.participants.length, 2))
  })
}

async function leaveRoom() {
  navigateTo('/dashboard')
}
</script>

<template>
  <main class="chat" :class="{ 'chat--game': showGame && !!gameBus && memberCount === 2 }">
    <header class="chat__header">
      <button type="button" class="chat__back" aria-label="離開房間" @click="leaveRoom">‹</button>
      <div class="chat__head-center">
        <h1 class="chat__title">
          {{ roomName ?? '聊天室' }}
          <span v-if="currentTopology !== null" class="chat__lock" title="端對端加密">🔒</span>
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
          v-if="gameBus && memberCount === 2"
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
    <div v-else-if="currentTopology === 'mesh' && memberCount > 2" class="chat__banner chat__banner--info">
      <span>多人房間走 P2P mesh 傳輸（訊息最終一致、端對端加密）</span>
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

    <!-- 房內小遊戲：桌面右側玻璃卡、窄幕底部抽屜；斷線由面板顯示對局暫停 -->
    <Transition name="game">
      <aside v-if="showGame && gameBus && memberCount === 2 && user" class="chat__game">
        <div class="chat__game-tabs" role="tablist" aria-label="選擇遊戲">
          <button
            type="button"
            role="tab"
            data-testid="game-tab-ttt"
            :aria-selected="selectedGame === 'ttt'"
            :class="{ 'is-on': selectedGame === 'ttt' }"
            @click="selectedGame = 'ttt'"
          >井字棋</button>
          <button
            type="button"
            role="tab"
            data-testid="game-tab-gomoku"
            :aria-selected="selectedGame === 'gomoku'"
            :class="{ 'is-on': selectedGame === 'gomoku' }"
            @click="selectedGame = 'gomoku'"
          >五子棋</button>
        </div>
        <TicTacToePanel
          v-if="selectedGame === 'ttt'"
          :bus="gameBus"
          :is-initiator="isRoomOwner"
          :self-id="user.uid"
          :connected="connectionState === 'connected'"
          @close="showGame = false"
        />
        <GomokuPanel
          v-else
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
  width: 320px;
  z-index: 30;
  border-radius: var(--r-card);
  box-shadow: var(--shadow-2);
  backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat__game-tabs {
  display: flex;
  gap: 6px;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--separator);
  border-radius: var(--r-card);
}
.chat__game-tabs button {
  flex: 1;
  padding: 7px 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-btn);
}
.chat__game-tabs button.is-on {
  color: var(--text);
  background: var(--bubble-other);
  border-color: var(--separator);
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
