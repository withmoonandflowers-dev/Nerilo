<script setup lang="ts">
import { RoomService } from '@legacy/services/RoomService'
import { FriendService, type Friendship } from '@legacy/services/FriendService'
import { indexedDBService } from '@legacy/services/IndexedDBService'
import { decodeContent } from '@legacy/features/chat/messageContent'
import { localTimezone, timezoneToLatLng } from '@legacy/utils/geo'
import type { P2PRoom, RoomMemberState } from '@legacy/types'
import { featureLog } from '@legacy/utils/featureLog'
import { gradientFor, initialFor } from '~/lib/avatar'

const { user, loading, logout } = useAuth()
const { error: toastError, success } = useToast()
const { balance, relayActive, ensureInit } = useCredits()
// 全站節點 presence（P4-A）：開著 dashboard 即宣告可守護，並看得到其他在線節點數。
const { peerCount, announcing, start: startPresence, stop: stopPresence } = useNodePresence()
// 盲信使節點（ADR-0023 P4-C）：信使角色 always-on + 成員背景備份；預設參與、可關。
const {
  start: startCourierNode,
  stop: stopCourierNode,
  tombstoneRoom,
  setRoomAdvertSource,
  roomDirectory,
} = useCourierNode()
const { theme, cycleTheme } = useTheme()
const themeLabel = computed(() => ({ neo: 'NEO', light: '亮', dark: '暗' })[theme.value])

const myRooms = ref<P2PRoom[]>([])
const memberStates = ref<Record<string, RoomMemberState>>({})
const previews = ref<Record<string, string>>({})
const showSheet = ref(false)
const sheetTab = ref<'create' | 'join'>('create')
const roomName = ref('')
const joinCode = ref('')
const busy = ref(false)
/** 開啟動作選單的房間 id（⋯ 按鈕） */
const menuRoomId = ref<string | null>(null)
// 選單 Teleport 到 body + fixed 定位：列表卡片 overflow:hidden 會裁掉往下展開的
// 選單（房少時退出/刪除點不到）。fixed 脫離裁切；點按鈕時算座標並依空間翻轉上下。
const menuStyle = ref<Record<string, string>>({})

function toggleMenu(roomId: string, event: MouseEvent) {
  if (menuRoomId.value === roomId) {
    menuRoomId.value = null
    return
  }
  const btn = event.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  const MENU_W = 160
  const MENU_H = 132 // 三項約略高度
  const spaceBelow = window.innerHeight - r.bottom
  const top = spaceBelow < MENU_H + 12 ? r.top - MENU_H - 4 : r.bottom + 4
  const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8))
  menuStyle.value = { top: `${Math.max(8, top)}px`, left: `${left}px` }
  menuRoomId.value = roomId
}

// 點外部 / 捲動 / Esc 關閉選單
function closeMenu() {
  menuRoomId.value = null
}
function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeMenu()
    confirmDialog.value = null
  }
}
onMounted(() => {
  window.addEventListener('click', closeMenu)
  window.addEventListener('scroll', closeMenu, true)
  window.addEventListener('keydown', onMenuKeydown)
})
onUnmounted(() => {
  window.removeEventListener('click', closeMenu)
  window.removeEventListener('scroll', closeMenu, true)
  window.removeEventListener('keydown', onMenuKeydown)
  void stopPresence()
})

const selfPoint = [{ coord: timezoneToLatLng(localTimezone()), self: true }]

let unsubMine: (() => void) | null = null
let unsubFriends: (() => void) | null = null
// P2P 房間目錄：其他節點經 relay bus 廣播來的簽章公開房（不經 Firestore 大廳查詢）
const p2pRooms = shallowRef<import('@legacy/core/relay/RoomDirectoryGossip').RoomAdvert[]>([])
let unsubRoomDir: (() => void) | null = null
const friendships = ref<Friendship[]>([])
/** 待我接受的邀請數（header 徽章） */
const pendingCount = computed(
  () => friendships.value.filter((f) => f.status === 'pending' && f.requestedBy !== user.value?.uid).length
)

watchEffect(() => {
  if (loading.value) return
  if (!user.value) return
  if (unsubMine) return
  const uid = user.value.uid
  featureLog('dashboard', 'init', { uid })
  ensureInit() // 點數餘額載入（中繼狀態指示）
  void startPresence(uid) // 宣告本節點在線可守護 + 週期查在線節點數
  startCourierNode(uid) // 盲信使：接受寄存 + 背景備份自己房間（預設參與，可關）
  // P2P 房間目錄：廣播「我的公開房」給連上的節點；收到別人的入 p2pRooms
  setRoomAdvertSource(() =>
    myRooms.value
      .filter((r) => !r.isPrivate && r.status !== 'closed' && r.kind !== 'dm')
      .map((r) => ({
        roomId: r.roomId,
        roomName: r.roomName ?? '未命名聊天室',
        participantCount: r.participants.length,
      }))
  )
  unsubRoomDir = roomDirectory.onChange(() => {
    p2pRooms.value = roomDirectory.list().filter((ad) => ad.ownerUid !== uid) // 自己的房不用看廣告
  })
  unsubFriends = FriendService.subscribeFriendships(uid, (list) => {
    friendships.value = list
  })
  unsubMine = RoomService.subscribeUserRooms(uid, (rooms: P2PRoom[]) => {
    myRooms.value = rooms.filter((r) => r.status !== 'closed')
    loadPreviews(myRooms.value)
    // 成員狀態（已讀/釘選/軟刪除）批次載入；寫入走 optimistic 本地更新
    RoomService.getMyMemberStates(rooms.map((r) => r.roomId), uid).then((map) => {
      const next: Record<string, RoomMemberState> = {}
      map.forEach((state, roomId) => { next[roomId] = state })
      memberStates.value = next
    }).catch(() => {})
  })
})

onUnmounted(() => {
  unsubMine?.()
  unsubFriends?.()
  unsubRoomDir?.()
  void stopCourierNode() // 盲信使節點清理（關頁即停幫忙）
})

/** DM 房顯示對方名字（roomName 是共享欄位，雙方視角不同 → 由 friendship 解析） */
function displayNameFor(room: P2PRoom): string {
  if (room.kind === 'dm') {
    const f = friendships.value.find((x) => x.dmRoomId === room.roomId)
    if (f && user.value) {
      const other = f.uids.find((u) => u !== user.value!.uid)
      const name = other ? f.names[other] : undefined
      if (name) return name
    }
  }
  return room.roomName ?? '未命名聊天室'
}

// ── 列表：隱藏已刪除；釘選一定高於未釘選；同狀態按最後更新新→舊 ──────
const visibleRooms = computed(() => {
  const stateOf = (r: P2PRoom) => memberStates.value[r.roomId]
  const sortKey = (r: P2PRoom) => r.lastActiveAt ?? r.createdAt
  return myRooms.value
    .filter((r) => !stateOf(r)?.deletedAt)
    .sort((a, b) => {
      const pinA = stateOf(a)?.pinnedAt ? 1 : 0
      const pinB = stateOf(b)?.pinnedAt ? 1 : 0
      if (pinA !== pinB) return pinB - pinA
      return sortKey(b) - sortKey(a)
    })
})

function isPinned(room: P2PRoom): boolean {
  return !!memberStates.value[room.roomId]?.pinnedAt
}

/** 未讀：房間最後活躍晚於我的最後已讀（皆為 metadata，內容不經伺服器） */
function isUnread(room: P2PRoom): boolean {
  const lastRead = memberStates.value[room.roomId]?.lastReadAt ?? 0
  return (room.lastActiveAt ?? 0) > lastRead
}

function patchState(roomId: string, patch: Partial<RoomMemberState>) {
  memberStates.value = {
    ...memberStates.value,
    [roomId]: { ...memberStates.value[roomId], ...patch },
  }
}

async function togglePin(room: P2PRoom) {
  if (!user.value) return
  menuRoomId.value = null
  const next = !isPinned(room)
  patchState(room.roomId, { pinnedAt: next ? Date.now() : null })
  try {
    await RoomService.setPinned(room.roomId, user.value.uid, next)
  } catch {
    toastError('釘選失敗，請再試一次')
    patchState(room.roomId, { pinnedAt: next ? null : Date.now() })
  }
}

// 自訂確認 modal（取代 window.confirm）：原生 confirm 同步阻塞 renderer
// （自動化/部分行動 webview 會卡死），且醜、破壞 neo 設計。改自訂非阻塞 modal。
interface ConfirmDialog {
  title: string
  message: string
  confirmText: string
  danger: boolean
  onConfirm: () => void | Promise<void>
}
const confirmDialog = ref<ConfirmDialog | null>(null)
function askConfirm(opts: ConfirmDialog) {
  confirmDialog.value = opts
}
async function runConfirm() {
  const d = confirmDialog.value
  confirmDialog.value = null
  if (d) await d.onConfirm()
}

function exitRoomAction(room: P2PRoom) {
  if (!user.value) return
  menuRoomId.value = null
  askConfirm({
    title: '退出聊天室',
    message: `退出「${room.roomName ?? '未命名聊天室'}」？其他成員仍保留此聊天室。`,
    confirmText: '退出',
    danger: false,
    onConfirm: async () => {
      try {
        await RoomService.exitRoom(room.roomId, user.value!.uid)
        success('已退出聊天室')
      } catch {
        toastError('退出失敗，請再試一次')
      }
    },
  })
}

function deleteRoomAction(room: P2PRoom) {
  if (!user.value) return
  menuRoomId.value = null
  askConfirm({
    title: '刪除聊天室',
    message: `刪除「${room.roomName ?? '未命名聊天室'}」？此聊天室將從你的列表消失；所有成員都刪除後才會真正刪除。`,
    confirmText: '刪除',
    danger: true,
    onConfirm: async () => {
      patchState(room.roomId, { deletedAt: Date.now() })
      try {
        const result = await RoomService.softDeleteRoom(room.roomId, user.value!.uid)
        // 房間真正刪除（所有成員皆刪）→ 簽房籍墓碑請盲信使丟掉代管副本（best-effort，不擋 UI）。
        if (result === 'deleted') void tombstoneRoom(room.roomId)
        success(result === 'deleted' ? '聊天室已刪除（所有成員皆已刪除）' : '已從你的列表刪除')
      } catch {
        toastError('刪除失敗，請再試一次')
        patchState(room.roomId, { deletedAt: undefined })
      }
    },
  })
}

/** 最後一則訊息預覽：來源是本機 IndexedDB 聊天史（E2EE 下伺服器沒有明文可讀，這是誠實的唯一來源） */
async function loadPreviews(rooms: P2PRoom[]) {
  for (const room of rooms) {
    try {
      const msgs = await indexedDBService.getChatMessages(room.roomId, 1)
      const last = msgs[msgs.length - 1]
      if (last && !last.deleted) previews.value[room.roomId] = decodeContent(last.content).text
    } catch {
      /* 無本機歷史 → 顯示 fallback 文案 */
    }
  }
}

function previewFor(room: P2PRoom): string {
  if (previews.value[room.roomId]) return previews.value[room.roomId]!
  if (room.status === 'waiting') return '等待成員加入…'
  return `${room.participants.length} 位成員 · 端對端加密`
}

function openRoom(room: P2PRoom) {
  // 進房即已讀（optimistic + 背景寫入；聊天頁在房內收訊也會續刷）
  if (user.value) {
    patchState(room.roomId, { lastReadAt: Date.now() })
    RoomService.markRead(room.roomId, user.value.uid).catch(() => {})
  }
  if (room.status === 'waiting') navigateTo(`/waiting/${room.roomId}`)
  else navigateTo(`/chat/${room.roomId}`)
}

async function handleCreate() {
  if (!user.value || user.value.isAnonymous) {
    // firestore.rules 限制匿名用戶建房（sign_in_provider != "anonymous"）
    toastError('建立房間需要先登入')
    showSheet.value = false
    navigateTo('/login')
    return
  }
  busy.value = true
  try {
    const roomId = await RoomService.createRoom(
      user.value.uid,
      user.value.displayName ?? '訪客',
      // isPrivate=false（對齊 React 版預設）：私房會讓非參與者連 getRoom 都被
      // 規則拒絕，「分享連結邀人」整條路壞掉。私密房等有 UI 開關再開放。
      false,
      undefined,
      undefined,
      undefined,
      roomName.value.trim() || undefined
    )
    featureLog('dashboard', 'room_created', { roomId })
    showSheet.value = false
    roomName.value = ''
    navigateTo(`/waiting/${roomId}`)
  } catch (e) {
    toastError(`建立房間失敗：${e instanceof Error ? e.message : '未知錯誤'}`)
  } finally {
    busy.value = false
  }
}

async function handleJoin() {
  if (!user.value || !joinCode.value.trim()) return
  busy.value = true
  const roomId = joinCode.value.trim().split('/').pop() ?? ''
  try {
    const room = await RoomService.getRoom(roomId)
    if (!room) {
      toastError('房間不存在')
      return
    }
    if (room.status === 'closed') {
      toastError('房間已關閉')
      return
    }
    showSheet.value = false
    joinCode.value = ''
    if (room.status === 'waiting') navigateTo(`/waiting/${roomId}`)
    else navigateTo(`/chat/${roomId}`)
  } catch {
    toastError('加入房間失敗')
  } finally {
    busy.value = false
  }
}

async function handleLogout() {
  await logout()
  success('已登出')
  navigateTo('/login')
}

function relativeTime(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return new Date(ts).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}
</script>

<template>
  <main class="dash">
    <header class="dash__header">
      <h1 class="dash__title">聊天</h1>
      <div class="dash__actions">
        <button type="button" class="dash__icon-btn" :aria-label="`切換主題（目前 ${themeLabel}）`"
                :title="`主題：${themeLabel}`" @click="cycleTheme">◐</button>
        <button type="button" class="dash__icon-btn dash__icon-btn--friends" aria-label="好友" @click="navigateTo('/friends')">
          👥<span v-if="pendingCount" class="dash__badge">{{ pendingCount }}</span>
        </button>
        <button v-if="user && !user.isAnonymous" type="button" class="dash__icon-btn" aria-label="登出" @click="handleLogout">⏻</button>
        <NuxtLink v-else to="/login" class="dash__login-link">登入</NuxtLink>
        <button type="button" class="dash__icon-btn dash__icon-btn--primary" aria-label="建立或加入房間" @click="showSheet = true">＋</button>
      </div>
    </header>

    <!-- 中繼狀態 × 點數（誠實顯示：只反映真實連線與真實進帳） -->
    <section v-if="user" class="card dash__relay" aria-label="中繼狀態與點數">
      <span class="dash__relay-dot" :class="{ 'dash__relay-dot--active': relayActive || announcing }" aria-hidden="true" />
      <span class="dash__relay-text">
        {{ relayActive ? '節點中繼中 · 累積點數' : '節點待命中' }}
        <template v-if="announcing && peerCount > 0"> · 還有 <span data-testid="online-node-count">{{ peerCount }}</span> 個節點一起守護</template>
      </span>
      <span class="dash__relay-balance">✦ {{ balance }}</span>
    </section>

    <section v-if="loading" class="dash__skeleton">
      <div v-for="i in 3" :key="i" class="dash__skeleton-row" />
    </section>

    <template v-else>
      <!-- 聊天室列表：持久、私人（連結即邀請）；釘選 > 未釘選，同組按最後更新 -->
      <section v-if="visibleRooms.length" class="dash__list card">
        <div v-for="(room, i) in visibleRooms" :key="room.roomId"
             class="room-row stagger" :style="{ '--i': Math.min(i, 8) }"
             role="button" tabindex="0"
             @click="openRoom(room)" @keydown.enter="openRoom(room)">
          <span class="room-row__avatar" :style="{ background: gradientFor(room.roomId) }">
            {{ initialFor(room.roomName, '聊') }}
          </span>
          <span class="room-row__body">
            <span class="room-row__name" :class="{ 'room-row__name--unread': isUnread(room) }">
              <span v-if="isPinned(room)" class="room-row__pin" aria-label="已釘選">📌</span>
              {{ displayNameFor(room) }}
            </span>
            <span class="room-row__meta">{{ previewFor(room) }}</span>
          </span>
          <span class="room-row__right">
            <span class="room-row__time">{{ relativeTime(room.lastActiveAt ?? room.createdAt) }}</span>
            <span class="room-row__stack">
              <span v-for="p in room.participants.slice(0, 3)" :key="p"
                    class="mini-avatar" :style="{ background: gradientFor(p) }" />
              <span v-if="room.participants.length > 3" class="mini-avatar mini-avatar--more">
                +{{ room.participants.length - 3 }}
              </span>
            </span>
          </span>
          <span v-if="isUnread(room)" class="room-row__dot" aria-label="有未讀訊息" />
          <button type="button" class="room-row__more" :aria-label="`聊天室選項：${room.roomName ?? '未命名聊天室'}`"
                  @click.stop="toggleMenu(room.roomId, $event)">⋯</button>

          <!-- 動作選單：Teleport 到 body + fixed，避免被列表卡片 overflow 裁切 -->
          <Teleport to="body">
            <div v-if="menuRoomId === room.roomId" class="room-menu" :style="menuStyle" @click.stop>
              <button type="button" @click="togglePin(room)">
                {{ isPinned(room) ? '取消釘選' : '釘選置頂' }}
              </button>
              <button type="button" @click="exitRoomAction(room)">退出聊天室</button>
              <button type="button" class="room-menu__danger" @click="deleteRoomAction(room)">刪除聊天室</button>
            </div>
          </Teleport>
        </div>
      </section>

      <section v-else class="dash__empty">
        <ConnectionGlobe :points="selfPoint" :size="180" :speed="0.7" />
        <p class="dash__empty-title">還沒有任何對話</p>
        <p class="dash__empty-sub">你的訊息點對點直達，不經過伺服器</p>
        <button type="button" class="btn-primary dash__empty-cta" @click="showSheet = true; sheetTab = 'create'">
          建立第一個聊天室
        </button>
      </section>

      <!-- P2P 房間目錄：其他節點經 relay 廣播來的簽章公開房（不經伺服器大廳查詢） -->
      <section v-if="p2pRooms.length" class="dash__list card" aria-label="P2P 發現的公開房間" data-testid="p2p-room-directory">
        <p class="dash__p2p-title">附近節點的公開房間<span class="dash__p2p-badge">P2P</span></p>
        <div v-for="ad in p2pRooms" :key="ad.roomId" class="room-row"
             :data-testid="`p2p-room-ad-${ad.roomId}`"
             @click="navigateTo(`/chat/${ad.roomId}`)">
          <span class="room-row__avatar" :style="{ background: gradientFor(ad.roomId) }">
            {{ initialFor(ad.roomName) }}
          </span>
          <span class="room-row__body">
            <span class="room-row__name">{{ ad.roomName }}</span>
            <span class="room-row__meta">{{ ad.participantCount }} 人 · 經節點廣播發現</span>
          </span>
        </div>
      </section>
    </template>

    <!-- 建立 / 加入 sheet -->
    <Transition name="sheet">
      <div v-if="showSheet" class="sheet-backdrop" @click.self="showSheet = false">
        <div class="sheet card" role="dialog" aria-modal="true">
          <div class="sheet__handle" />
          <div class="sheet__tabs">
            <button type="button" :class="{ active: sheetTab === 'create' }" @click="sheetTab = 'create'">建立房間</button>
            <button type="button" :class="{ active: sheetTab === 'join' }" @click="sheetTab = 'join'">加入房間</button>
          </div>

          <form v-if="sheetTab === 'create'" class="sheet__form" @submit.prevent="handleCreate">
            <input v-model="roomName" class="field" placeholder="房間名稱（選填）" maxlength="30" />
            <p class="sheet__hint">🔒 端對端加密預設開啟，訊息以點對點傳遞</p>
            <button type="submit" class="btn-primary" :disabled="busy">
              {{ busy ? '建立中…' : '建立房間' }}
            </button>
          </form>

          <form v-else class="sheet__form" @submit.prevent="handleJoin">
            <input v-model="joinCode" class="field" placeholder="貼上房間連結或代碼" />
            <button type="submit" class="btn-primary" :disabled="busy || !joinCode.trim()">
              {{ busy ? '確認中…' : '加入' }}
            </button>
          </form>
        </div>
      </div>
    </Transition>

    <!-- 自訂確認 modal（取代 window.confirm；neo 風、非阻塞、可鍵盤操作） -->
    <Teleport to="body">
      <Transition name="confirm">
        <div v-if="confirmDialog" class="confirm-backdrop" @click.self="confirmDialog = null">
          <div class="confirm card" role="alertdialog" aria-modal="true">
            <h3 class="confirm__title">{{ confirmDialog.title }}</h3>
            <p class="confirm__msg">{{ confirmDialog.message }}</p>
            <div class="confirm__actions">
              <button type="button" class="confirm__cancel" @click="confirmDialog = null">取消</button>
              <button type="button" class="confirm__ok" :class="{ 'confirm__ok--danger': confirmDialog.danger }"
                      @click="runConfirm">{{ confirmDialog.confirmText }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>

<style scoped>
.dash {
  max-width: 640px;
  margin: 0 auto;
  padding: calc(env(safe-area-inset-top, 0px) + 16px) 16px 32px;
}
.dash__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px 16px;
}
.dash__title {
  margin: 0;
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.6px;
}
.dash__actions { display: flex; align-items: center; gap: 10px; }
.dash__icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-1);
  font-size: 18px;
  color: var(--text-2);
  transition: transform var(--t-fast) var(--spring);
}
.dash__icon-btn:active { transform: scale(0.92); }
.dash__icon-btn--primary {
  background: var(--primary);
  color: #fff;
  font-size: 22px;
  font-weight: 600;
}
.dash__login-link {
  font-size: 16px;
  color: var(--primary);
  font-weight: 500;
  text-decoration: none;
}
.dash__list { overflow: hidden; }
.room-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.room-row__name--unread { font-weight: 700; }
.dash__icon-btn--friends { position: relative; }
.dash__relay {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 14px;
  font-size: 13px;
}
.dash__relay-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.dash__relay-dot--active {
  background: var(--success);
  box-shadow: 0 0 8px var(--success);
}
.dash__relay-text { flex: 1; color: var(--text-2); }
.dash__relay-balance { font-weight: 700; color: var(--text); }
.dash__badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.room-row__pin { font-size: 11px; margin-right: 2px; }
.room-row__more {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
}
.room-row__more:hover { background: var(--bubble-other); }
/* Teleport 到 body：fixed 定位（top/left 由 :style 提供），脫離列表卡片
   overflow:hidden 的裁切。scoped 的 data-v attribute 仍加在 Teleport 內容上，選擇器照常命中。 */
.room-menu {
  position: fixed;
  z-index: 200;
  display: flex;
  flex-direction: column;
  width: 160px;
  background: var(--surface);
  border: 1px solid var(--separator);
  border-radius: var(--r-btn);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}
.room-menu button {
  padding: 11px 14px;
  text-align: left;
  font-size: 14px;
  color: var(--text);
}
.room-menu button:hover { background: var(--bubble-other); }
.room-menu button:not(:last-child) { border-bottom: 0.5px solid var(--separator); }
.room-menu__danger { color: var(--danger) !important; }
.room-row:not(:last-child) { border-bottom: 0.5px solid var(--separator); }
.room-row:active { background: var(--bg); }
.room-row__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  color: #fff;
  font-size: 20px;
  font-weight: 600;
  flex-shrink: 0;
}
.room-row__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.room-row__name {
  font-size: 17px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.room-row__meta {
  font-size: 14px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.room-row__right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}
.room-row__time { font-size: 13px; color: var(--text-2); }
.room-row__stack { display: flex; }
.mini-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--surface);
  margin-left: -6px;
}
.mini-avatar:first-child { margin-left: 0; }
.mini-avatar--more {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bubble-other);
  color: var(--text-2);
  font-size: 9px;
  font-weight: 700;
}
.room-row__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--primary);
  flex-shrink: 0;
}
.room-row__chevron { font-size: 20px; color: var(--text-3); flex-shrink: 0; }

.dash__section-title {
  margin: 24px 4px 8px;
  font-size: 20px;
  font-weight: 700;
}
.dash__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 24px 64px;
  text-align: center;
}
.dash__empty-title { margin: 16px 0 0; font-size: 20px; font-weight: 700; }
.dash__empty-sub { margin: 0 0 16px; font-size: 15px; color: var(--text-2); }
.dash__empty-cta { max-width: 260px; }

.dash__skeleton { display: flex; flex-direction: column; gap: 10px; }
.dash__skeleton-row {
  height: 72px;
  border-radius: var(--r-card);
  background: linear-gradient(90deg, var(--surface) 25%, var(--bg) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer { to { background-position: -200% 0; } }

.sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 100;
}
.sheet {
  width: min(560px, 100%);
  border-radius: var(--r-card) var(--r-card) 0 0;
  padding: 10px 20px calc(env(safe-area-inset-bottom, 0px) + 24px);
}
.sheet__handle {
  width: 36px;
  height: 5px;
  border-radius: 3px;
  background: var(--text-3);
  margin: 0 auto 14px;
}
.sheet__tabs {
  display: flex;
  background: var(--bg);
  border-radius: var(--r-btn);
  padding: 3px;
  margin-bottom: 16px;
}
.sheet__tabs button {
  flex: 1;
  padding: 8px;
  border-radius: 9px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-2);
  transition: all var(--t-fast) var(--ease);
}
.sheet__tabs button.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-1);
}
.sheet__form { display: flex; flex-direction: column; gap: 12px; }
.sheet__hint { margin: 0; font-size: 13px; color: var(--text-2); }

.sheet-enter-active { transition: opacity var(--t-mid) var(--ease); }
.sheet-enter-active .sheet { transition: transform var(--t-mid) var(--spring); }
.sheet-leave-active { transition: opacity var(--t-fast) var(--ease); }
.sheet-enter-from { opacity: 0; }
.sheet-enter-from .sheet { transform: translateY(100%); }
.sheet-leave-to { opacity: 0; }

/* 自訂確認 modal（Teleport 到 body） */
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  backdrop-filter: blur(6px);
}
.confirm {
  width: 100%;
  max-width: 340px;
  padding: 22px 20px 16px;
  border-radius: var(--r-card);
  background: var(--surface);
  border: 1px solid var(--separator);
  box-shadow: var(--shadow-2);
}
.confirm__title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
}
.confirm__msg {
  margin: 0 0 20px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-2);
}
.confirm__actions {
  display: flex;
  gap: 10px;
}
.confirm__cancel,
.confirm__ok {
  flex: 1;
  padding: 11px;
  border-radius: var(--r-btn);
  font-size: 15px;
  font-weight: 600;
}
.confirm__cancel {
  background: var(--bubble-other);
  color: var(--text);
}
.confirm__ok {
  background: var(--primary);
  color: var(--on-primary);
}
.confirm__ok--danger { background: var(--danger); }

.confirm-enter-active,
.confirm-leave-active { transition: opacity var(--t-fast) var(--ease); }
.confirm-enter-active .confirm,
.confirm-leave-active .confirm { transition: transform var(--t-fast) var(--spring); }
.confirm-enter-from,
.confirm-leave-to { opacity: 0; }
.confirm-enter-from .confirm { transform: scale(0.92); }

/* P2P 房間目錄 */
.dash__p2p-title {
  margin: 4px 12px 8px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary, #8a8a8e);
  display: flex;
  align-items: center;
  gap: 6px;
}
.dash__p2p-badge {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent, #6c8cff);
  color: #fff;
}
</style>
