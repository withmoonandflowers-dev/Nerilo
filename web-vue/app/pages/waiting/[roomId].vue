<script setup lang="ts">
import QRCode from 'qrcode'
import { RoomService } from '@legacy/services/RoomService'
import { IdentityManager } from '@legacy/core/mesh/IdentityManager'
import { buildInviteUrl, parseInviteRendezvous, introducerStoreKey } from '@legacy/core/p2p/InviteRendezvous'
import type { P2PRoom } from '@legacy/types'
import { featureLog } from '@legacy/utils/featureLog'
import {
  normalizeRendezvousUrl,
  readUserRendezvousUrl,
  rememberInviteRendezvousUrl,
  resolveRendezvousUrl,
  saveUserRendezvousUrl,
} from '~/lib/rendezvousConfig'

definePageMeta({ pageTransition: { name: 'slide', mode: 'out-in' } })

const route = useRoute()
const roomId = computed(() => String(route.params.roomId ?? ''))
const { user, loading } = useAuth()
const { success, error: toastError } = useToast()

const room = ref<P2PRoom | null>(null)
const qrDataUrl = ref('')
const busy = ref(false)
const notFound = ref(false)
const deploymentRendezvousUrl = import.meta.env.VITE_RENDEZVOUS_URL as string | undefined
const rendezvousInput = ref(import.meta.client
  ? (readUserRendezvousUrl() ?? normalizeRendezvousUrl(deploymentRendezvousUrl) ?? '')
  : '')
let shareInviter: { uid: string; pubKey?: string; ecdhPubKey?: string } | null = null

// 分享連結：內嵌會合資訊（Spec 005 T4）——邀請者 uid+公鑰放 fragment（不上送伺服器）。
// 身分金鑰非同步載入，先給素連結、就緒後升級成帶會合的完整版（QR 用完整版）。
const shareUrl = ref('')
watchEffect(() => {
  if (import.meta.client && roomId.value) {
    shareUrl.value = `${window.location.origin}/waiting/${roomId.value}`
  }
})
const isOwner = computed(() => !!user.value && room.value?.ownerUid === user.value.uid)

let unsubscribe: (() => void) | null = null
let initialized = false

watchEffect(async () => {
  if (loading.value || !user.value || !roomId.value || initialized) return
  initialized = true
  const uid = user.value.uid
  featureLog('waiting', 'init', { roomId: roomId.value, uid })

  // ── 被邀請側（Spec 005 T4）：解析連結 fragment 的會合資訊 → 暫存供 chat 頁指名介紹人 ──
  if (import.meta.client) {
    const rz = parseInviteRendezvous(window.location.hash)
    if (rz && rz.room === roomId.value && rz.inviter.uid !== uid) {
      try {
        sessionStorage.setItem(introducerStoreKey(roomId.value), JSON.stringify(rz.inviter))
        if (rz.rendezvousUrl) {
          rememberInviteRendezvousUrl(roomId.value, rz.rendezvousUrl)
          rendezvousInput.value = rz.rendezvousUrl
        }
        featureLog('waiting', 'rendezvous-parsed', { roomId: roomId.value, introducer: rz.inviter.uid })
      } catch { /* sessionStorage 不可用（隱私模式）→ 走一般冷啟動，功能不受阻 */ }
    }
  }

  // R11：私有房非成員會被 firestore.rules 拒絕加入前讀取。只有這個錯誤可先略過，
  // 讓 joinRoom 取得房籍後再讀；其他讀取錯誤維持原本的失敗行為。
  let current: P2PRoom | null = null
  let preJoinReadDenied = false
  try {
    current = await RoomService.getRoom(roomId.value, true)
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code ?? ''
    if (code !== 'permission-denied' && !code.endsWith('/permission-denied')) throw e
    preJoinReadDenied = true
    featureLog('waiting', 'pre-join-read-denied', { roomId: roomId.value, uid })
  }
  if (!current && !preJoinReadDenied) {
    notFound.value = true
    return
  }
  if (current?.status === 'closed') {
    toastError('房間已關閉')
    navigateTo('/dashboard', { replace: true })
    return
  }
  if (current?.status === 'open') {
    navigateTo(`/chat/${roomId.value}`, { replace: true })
    return
  }

  if (!current || !current.participants.includes(uid)) {
    try {
      await RoomService.joinRoom(roomId.value, uid)
      featureLog('waiting', 'joined', { roomId: roomId.value, uid })

      // 私有房在加入前不可讀。加入後的伺服器快照是房名、房主、名冊與
      // closed/open 導向的共同依據，不能沿用加入前的空值或舊快照。
      current = await RoomService.getRoom(roomId.value, true)
      if (!current) {
        notFound.value = true
        return
      }
      if (current.status === 'closed') {
        toastError('房間已關閉')
        navigateTo('/dashboard', { replace: true })
        return
      }
      if (current.status === 'open') {
        navigateTo(`/chat/${roomId.value}`, { replace: true })
        return
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : '加入房間失敗')
      navigateTo('/dashboard', { replace: true })
      return
    }
  }

  room.value = current
  unsubscribe = RoomService.subscribeRoom(roomId.value, (updated) => {
    if (!updated) {
      notFound.value = true
      return
    }
    room.value = updated
    if (updated.status === 'open') {
      navigateTo(`/chat/${roomId.value}`, { replace: true })
    } else if (updated.status === 'closed') {
      toastError('房主已關閉房間')
      navigateTo('/dashboard', { replace: true })
    }
  })

  // ── 邀請側（Spec 005 T4）：把自己的身分（uid+公鑰）嵌進分享連結 fragment ──
  // 被邀請者據此指名我為首個 warm 目標；公鑰作頻外信任根（防伺服器換鑰 MITM）。
  shareInviter = { uid }
  try {
    const idm = new IdentityManager()
    await idm.initialize()
    shareInviter = {
      uid,
      pubKey: await idm.exportPublicKey(),
      ecdhPubKey: await idm.exportEcdhPublicKey(),
    }
  } catch {
    /* 金鑰不可用（極舊環境）→ 素連結照常可用，只是少了會合資訊 */
  }
  await refreshShareArtifacts()
})

onUnmounted(() => unsubscribe?.())

async function refreshShareArtifacts() {
  if (!import.meta.client || !shareInviter) return
  const rendezvousUrl = resolveRendezvousUrl(roomId.value, deploymentRendezvousUrl)
  shareUrl.value = buildInviteUrl(window.location.origin, {
    room: roomId.value,
    inviter: shareInviter,
    ...(rendezvousUrl ? { rendezvousUrl } : {}),
  })
  qrDataUrl.value = await QRCode.toDataURL(shareUrl.value, {
    width: 480,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

async function saveRendezvousSetting() {
  const raw = rendezvousInput.value.trim()
  const normalized = normalizeRendezvousUrl(raw)
  if (raw && !normalized) {
    toastError('會合點網址必須是有效的 http 或 https 網址')
    return
  }
  saveUserRendezvousUrl(normalized)
  rendezvousInput.value = normalized ?? ''
  await refreshShareArtifacts()
  success(normalized ? '會合點網址已儲存' : '已改回預設會合方式')
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    success('連結已複製')
  } catch {
    toastError('複製失敗，請手動複製')
  }
}

async function shareLink() {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Nerilo 聊天邀請', url: shareUrl.value })
    } catch {
      /* 使用者取消分享 */
    }
  } else {
    copyLink()
  }
}

async function startChat() {
  if (!user.value || !room.value) return
  busy.value = true
  try {
    await RoomService.activateRoom(roomId.value, user.value.uid)
    featureLog('waiting', 'room_activated', { roomId: roomId.value })
    // subscribeRoom 收到 open 後會自動導向 /chat
  } catch (e) {
    toastError(`啟動房間失敗：${e instanceof Error ? e.message : '未知錯誤'}`)
    busy.value = false
  }
}
</script>

<template>
  <main class="waiting">
    <header class="waiting__nav">
      <NuxtLink to="/dashboard" class="waiting__back">‹ 返回</NuxtLink>
    </header>

    <section v-if="notFound" class="waiting__center">
      <p class="waiting__title">找不到這個房間</p>
      <NuxtLink to="/dashboard" class="btn-primary waiting__cta">回到聊天列表</NuxtLink>
    </section>

    <section v-else-if="!room" class="waiting__center">
      <div class="waiting__pulse" />
      <p class="waiting__sub">載入房間中…</p>
    </section>

    <section v-else class="waiting__content">
      <h1 class="waiting__title">{{ room.roomName ?? '邀請朋友加入' }}</h1>
      <p class="waiting__sub">掃描 QR code 或分享連結，對方點開就能加入</p>

      <div class="waiting__qr card">
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="房間邀請 QR code" />
      </div>

      <div class="waiting__members">
        <TransitionGroup name="pop">
          <span v-for="p in room.participants" :key="p" class="waiting__avatar"
                :class="{ 'waiting__avatar--owner': p === room.ownerUid }">
            {{ p === user?.uid ? '我' : '友' }}
          </span>
        </TransitionGroup>
      </div>
      <p class="waiting__count">{{ room.participants.length }} 位成員在房間裡</p>

      <div class="waiting__actions">
        <button type="button" class="btn-secondary" @click="copyLink">複製連結</button>
        <button type="button" class="btn-secondary" @click="shareLink">分享…</button>
      </div>

      <div class="waiting__rendezvous card">
        <label for="rendezvous-url">本地會合點網址（選填）</label>
        <input id="rendezvous-url" v-model="rendezvousInput" type="url"
               placeholder="http://區網位址:連接埠" autocomplete="url" />
        <button type="button" class="btn-secondary" @click="saveRendezvousSetting">儲存會合點</button>
        <p>邀請資料優先，其次使用這裡的設定；留空時使用部署設定或既有 Firestore。</p>
      </div>

      <button v-if="isOwner" type="button" class="btn-primary waiting__start"
              :disabled="busy || room.participants.length < 2" @click="startChat">
        {{ busy ? '啟動中…' : room.participants.length < 2 ? '等待成員加入…' : '開始聊天' }}
      </button>
      <p v-else class="waiting__sub waiting__breathe">等待房主開始聊天…</p>
    </section>
  </main>
</template>

<style scoped>
.waiting {
  max-width: 560px;
  margin: 0 auto;
  min-height: 100%;
  padding: calc(env(safe-area-inset-top, 0px) + 12px) 20px 32px;
  display: flex;
  flex-direction: column;
}
.waiting__nav { padding-bottom: 8px; }
.waiting__back {
  font-size: 17px;
  color: var(--primary);
  text-decoration: none;
  font-weight: 500;
  /* 加大點擊區（原本只有文字寬，觸控/滑鼠都難點中） */
  display: inline-flex;
  align-items: center;
  padding: 8px 14px 8px 4px;
  margin: -8px 0 -8px -4px;
  min-height: 44px;
}
.waiting__center,
.waiting__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
}
.waiting__title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.waiting__sub { margin: 0; font-size: 15px; color: var(--text-2); }
.waiting__qr {
  padding: 16px;
  margin: 20px 0 12px;
}
.waiting__qr img {
  display: block;
  width: min(240px, 60vw);
  height: auto;
  border-radius: 8px;
}
.waiting__members {
  display: flex;
  gap: -8px;
  margin-top: 4px;
}
.waiting__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #64B5FF, #0A84FF);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  border: 3px solid var(--bg);
  margin-left: -8px;
}
.waiting__avatar:first-child { margin-left: 0; }
.waiting__avatar--owner { background: linear-gradient(135deg, #FF9F0A, #FFC53D); }
.waiting__count { margin: 4px 0 0; font-size: 14px; color: var(--text-2); }
.waiting__actions {
  display: flex;
  gap: 12px;
  width: 100%;
  max-width: 360px;
  margin-top: 20px;
}
.waiting__rendezvous {
  width: 100%;
  max-width: 360px;
  margin-top: 12px;
  padding: 12px;
  display: grid;
  gap: 8px;
  text-align: left;
}
.waiting__rendezvous label { font-size: 14px; font-weight: 600; }
.waiting__rendezvous input {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--separator);
  border-radius: 10px;
  padding: 0 12px;
  color: var(--text-1);
  background: var(--bg);
}
.waiting__rendezvous p { margin: 0; font-size: 12px; color: var(--text-2); }
.waiting__start { max-width: 360px; margin-top: 12px; }
.waiting__cta { max-width: 260px; margin-top: 12px; }
.waiting__pulse {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--primary);
  opacity: 0.6;
  animation: pulse 1.4s var(--ease) infinite;
}
.waiting__breathe { animation: breathe 2s var(--ease) infinite; margin-top: 12px; }
@keyframes pulse {
  0%, 100% { transform: scale(0.85); opacity: 0.5; }
  50% { transform: scale(1); opacity: 0.9; }
}
@keyframes breathe {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
.pop-enter-active { transition: all var(--t-mid) var(--spring); }
.pop-enter-from { opacity: 0; transform: scale(0.4); }
</style>
