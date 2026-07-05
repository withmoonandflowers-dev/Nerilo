<script setup lang="ts">
/**
 * 好友頁：我的好友碼（分享）、以好友碼加好友、待接受邀請、好友列表（進 DM）。
 * DM 即一般持久聊天室（kind:'dm'），已讀/釘選/刪除全部沿用。
 */
import { FriendService, type Friendship } from '@legacy/services/FriendService'
import { featureLog } from '@legacy/utils/featureLog'
import { gradientFor, initialFor } from '~/lib/avatar'

definePageMeta({ pageTransition: { name: 'slide', mode: 'out-in' } })

const { user, loading } = useAuth()
const { error: toastError, success } = useToast()

const friendships = ref<Friendship[]>([])
const friendCode = ref('')
const busy = ref(false)
const copied = ref(false)

const myName = computed(
  () => user.value?.displayName ?? user.value?.email?.split('@')[0] ?? '我'
)

let unsub: (() => void) | null = null
watchEffect(() => {
  if (loading.value || !user.value || unsub) return
  featureLog('dashboard', 'friends_init', { uid: user.value.uid })
  unsub = FriendService.subscribeFriendships(user.value.uid, (list) => {
    friendships.value = list
  })
})
onUnmounted(() => unsub?.())

const incoming = computed(() =>
  friendships.value.filter((f) => f.status === 'pending' && f.requestedBy !== user.value?.uid)
)
const outgoing = computed(() =>
  friendships.value.filter((f) => f.status === 'pending' && f.requestedBy === user.value?.uid)
)
const friends = computed(() => friendships.value.filter((f) => f.status === 'accepted'))

function otherUid(f: Friendship): string {
  return f.uids.find((u) => u !== user.value?.uid) ?? ''
}
function otherName(f: Friendship): string {
  return f.names[otherUid(f)] ?? '朋友'
}

async function copyCode() {
  if (!user.value) return
  try {
    await navigator.clipboard.writeText(user.value.uid)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    toastError('複製失敗，請手動選取')
  }
}

async function addFriend() {
  if (!user.value || busy.value) return
  busy.value = true
  try {
    await FriendService.sendRequest(user.value.uid, myName.value, friendCode.value)
    success('邀請已送出')
    friendCode.value = ''
  } catch (e) {
    toastError(e instanceof Error ? e.message : '邀請失敗')
  } finally {
    busy.value = false
  }
}

async function acceptRequest(f: Friendship) {
  if (!user.value || busy.value) return
  busy.value = true
  try {
    const dmRoomId = await FriendService.accept(f, user.value.uid, myName.value)
    success('已成為好友，開始聊天吧')
    navigateTo(`/chat/${dmRoomId}`)
  } catch (e) {
    toastError(e instanceof Error ? e.message : '接受失敗')
  } finally {
    busy.value = false
  }
}

async function declineRequest(f: Friendship) {
  try {
    await FriendService.remove(f.id)
  } catch {
    toastError('操作失敗')
  }
}

function openDm(f: Friendship) {
  if (f.dmRoomId) navigateTo(`/chat/${f.dmRoomId}`)
}
</script>

<template>
  <main class="friends">
    <header class="friends__header">
      <button type="button" class="friends__back" aria-label="返回" @click="navigateTo('/dashboard')">‹</button>
      <h1 class="friends__title">好友</h1>
      <span class="friends__spacer" />
    </header>

    <section class="card friends__code">
      <p class="friends__code-label">我的好友碼</p>
      <p class="friends__code-value">{{ user?.uid ?? '…' }}</p>
      <button type="button" class="btn-primary" @click="copyCode">
        {{ copied ? '已複製 ✓' : '複製好友碼' }}
      </button>
    </section>

    <section class="card friends__add">
      <input
        v-model="friendCode"
        class="field"
        placeholder="貼上朋友的好友碼"
        aria-label="好友碼輸入框"
        @keydown.enter="addFriend"
      />
      <button type="button" class="btn-primary" :disabled="busy || !friendCode.trim()" @click="addFriend">
        加好友
      </button>
    </section>

    <template v-if="incoming.length">
      <h2 class="friends__section">待接受的邀請</h2>
      <section class="card">
        <div v-for="f in incoming" :key="f.id" class="friend-row">
          <span class="friend-row__avatar" :style="{ background: gradientFor(otherUid(f)) }">
            {{ initialFor(otherName(f), '友') }}
          </span>
          <span class="friend-row__name">{{ otherName(f) }}</span>
          <button type="button" class="btn-primary friend-row__accept" :disabled="busy" @click="acceptRequest(f)">接受</button>
          <button type="button" class="friend-row__decline" @click="declineRequest(f)">拒絕</button>
        </div>
      </section>
    </template>

    <template v-if="friends.length">
      <h2 class="friends__section">好友</h2>
      <section class="card">
        <button v-for="f in friends" :key="f.id" type="button" class="friend-row friend-row--link" @click="openDm(f)">
          <span class="friend-row__avatar" :style="{ background: gradientFor(otherUid(f)) }">
            {{ initialFor(otherName(f), '友') }}
          </span>
          <span class="friend-row__name">{{ otherName(f) }}</span>
          <span class="friend-row__chevron">›</span>
        </button>
      </section>
    </template>

    <template v-if="outgoing.length">
      <h2 class="friends__section">已送出（等待對方接受）</h2>
      <section class="card">
        <div v-for="f in outgoing" :key="f.id" class="friend-row">
          <span class="friend-row__avatar friend-row__avatar--pending">…</span>
          <span class="friend-row__name friend-row__name--pending">{{ otherUid(f) }}</span>
          <button type="button" class="friend-row__decline" @click="declineRequest(f)">取消</button>
        </div>
      </section>
    </template>

    <p v-if="!incoming.length && !friends.length && !outgoing.length" class="friends__empty">
      分享你的好友碼給朋友，或貼上對方的好友碼開始
    </p>
  </main>
</template>

<style scoped>
.friends {
  max-width: 640px;
  margin: 0 auto;
  padding: calc(env(safe-area-inset-top, 0px) + 16px) 16px 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.friends__header { display: flex; align-items: center; }
.friends__back { width: 36px; font-size: 28px; color: var(--primary); line-height: 1; }
.friends__title { flex: 1; text-align: center; margin: 0; font-size: 20px; font-weight: 700; }
.friends__spacer { width: 36px; }

.friends__code { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.friends__code-label { margin: 0; font-size: 13px; color: var(--text-2); }
.friends__code-value {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  word-break: break-all;
  color: var(--text);
}
.friends__add { padding: 16px; display: flex; gap: 8px; }
.friends__add .field { flex: 1; }

.friends__section { margin: 6px 4px 0; font-size: 13px; font-weight: 600; color: var(--text-2); }

.friend-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
}
.friend-row:not(:last-child) { border-bottom: 0.5px solid var(--separator); }
.friend-row--link { cursor: pointer; }
.friend-row--link:active { background: var(--bg); }
.friend-row__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  flex-shrink: 0;
}
.friend-row__avatar--pending { background: var(--bubble-other); color: var(--text-2); }
.friend-row__name { flex: 1; font-size: 15px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.friend-row__name--pending { font-family: ui-monospace, monospace; font-size: 12px; font-weight: 400; color: var(--text-2); }
.friend-row__accept { padding: 8px 14px; font-size: 14px; }
.friend-row__decline { color: var(--text-2); font-size: 14px; padding: 8px; }
.friend-row__chevron { color: var(--text-3); font-size: 18px; }
.friends__empty { text-align: center; color: var(--text-2); font-size: 14px; margin-top: 16px; }
</style>
