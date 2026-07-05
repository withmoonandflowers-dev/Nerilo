<script setup lang="ts">
import { RoomService } from '@legacy/services/RoomService'
import { indexedDBService } from '@legacy/services/IndexedDBService'
import { localTimezone, timezoneToLatLng } from '@legacy/utils/geo'
import type { P2PRoom } from '@legacy/types'
import { featureLog } from '@legacy/utils/featureLog'
import { gradientFor, initialFor } from '~/lib/avatar'

const { user, loading, logout } = useAuth()
const { error: toastError, success } = useToast()

const myRooms = ref<P2PRoom[]>([])
const publicRooms = ref<P2PRoom[]>([])
const previews = ref<Record<string, string>>({})
const showSheet = ref(false)
const sheetTab = ref<'create' | 'join'>('create')
const roomName = ref('')
const joinCode = ref('')
const busy = ref(false)

const selfPoint = [{ coord: timezoneToLatLng(localTimezone()), self: true }]

let unsubMine: (() => void) | null = null
let unsubPublic: (() => void) | null = null

watchEffect(() => {
  if (loading.value) return
  if (!user.value) return
  if (unsubMine) return
  const uid = user.value.uid
  featureLog('dashboard', 'init', { uid })
  unsubMine = RoomService.subscribeUserRooms(uid, (rooms: P2PRoom[]) => {
    myRooms.value = rooms.filter((r) => r.status !== 'closed')
    loadPreviews(myRooms.value)
  })
  unsubPublic = RoomService.subscribePublicRooms((rooms: P2PRoom[]) => {
    publicRooms.value = rooms
  })
})

onUnmounted(() => {
  unsubMine?.()
  unsubPublic?.()
})

/** 最後一則訊息預覽：來源是本機 IndexedDB 聊天史（E2EE 下伺服器沒有明文可讀，這是誠實的唯一來源） */
async function loadPreviews(rooms: P2PRoom[]) {
  for (const room of rooms) {
    try {
      const msgs = await indexedDBService.getChatMessages(room.roomId, 1)
      const last = msgs[msgs.length - 1]
      if (last && !last.deleted) previews.value[room.roomId] = last.content
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

/** 活動指示：房間的 lastActiveAt 比上次打開晚 → 藍點 */
const OPENED_KEY = (id: string) => `nerilo-room-opened:${id}`
function hasNewActivity(room: P2PRoom): boolean {
  const opened = Number(localStorage.getItem(OPENED_KEY(room.roomId)) ?? 0)
  return (room.lastActiveAt ?? 0) > opened
}

function openRoom(room: P2PRoom) {
  localStorage.setItem(OPENED_KEY(room.roomId), String(Date.now()))
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
        <button v-if="user && !user.isAnonymous" type="button" class="dash__icon-btn" aria-label="登出" @click="handleLogout">⏻</button>
        <NuxtLink v-else to="/login" class="dash__login-link">登入</NuxtLink>
        <button type="button" class="dash__icon-btn dash__icon-btn--primary" aria-label="建立或加入房間" @click="showSheet = true">＋</button>
      </div>
    </header>

    <section v-if="loading" class="dash__skeleton">
      <div v-for="i in 3" :key="i" class="dash__skeleton-row" />
    </section>

    <template v-else>
      <section v-if="myRooms.length" class="dash__list card">
        <button v-for="(room, i) in myRooms" :key="room.roomId" type="button"
                class="room-row stagger" :style="{ '--i': i }" @click="openRoom(room)">
          <span class="room-row__avatar" :style="{ background: gradientFor(room.roomId) }">
            {{ initialFor(room.roomName, '聊') }}
          </span>
          <span class="room-row__body">
            <span class="room-row__name">{{ room.roomName ?? '未命名房間' }}</span>
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
          <span v-if="hasNewActivity(room)" class="room-row__dot" aria-label="有新活動" />
          <span v-else class="room-row__chevron">›</span>
        </button>
      </section>

      <section v-else class="dash__empty">
        <ConnectionGlobe :points="selfPoint" :size="180" :speed="0.7" />
        <p class="dash__empty-title">還沒有任何對話</p>
        <p class="dash__empty-sub">你的訊息點對點直達，不經過伺服器</p>
        <button type="button" class="btn-primary dash__empty-cta" @click="showSheet = true; sheetTab = 'create'">
          建立第一個房間
        </button>
      </section>

      <template v-if="publicRooms.length">
        <h2 class="dash__section-title">公開房間</h2>
        <section class="dash__list card">
          <button v-for="(room, i) in publicRooms" :key="room.roomId" type="button"
                  class="room-row stagger" :style="{ '--i': Math.min(i, 8) }" @click="openRoom(room)">
            <span class="room-row__avatar" :style="{ background: gradientFor(room.roomId) }">
              {{ initialFor(room.roomName, '聊') }}
            </span>
            <span class="room-row__body">
              <span class="room-row__name">{{ room.roomName ?? '未命名房間' }}</span>
              <span class="room-row__meta">{{ room.participants.length }} 位成員</span>
            </span>
            <span class="room-row__stack">
              <span v-for="p in room.participants.slice(0, 3)" :key="p"
                    class="mini-avatar" :style="{ background: gradientFor(p) }" />
            </span>
            <span class="room-row__chevron">›</span>
          </button>
        </section>
      </template>
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
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  transition: background var(--t-fast) var(--ease);
}
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
</style>
