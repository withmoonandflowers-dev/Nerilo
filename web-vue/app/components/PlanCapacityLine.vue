<script setup lang="ts">
/**
 * 建房 sheet 的方案容量說明列（Spec 011 Q7：Free 5／Pro 10）。
 *
 * 結帳走 LS hosted checkout 開新分頁（同 React UpgradeButton）；付款後 claim
 * 由 webhook 寫入，本分頁靠 focus 迴圈 refresh 讓 Pro 即時生效（上限 30 分鐘，
 * 轉 pro 或逾時即停）。未設定結帳連結的環境（模擬器 E2E）不顯示升級鈕。
 * 匿名使用者沒有穩定帳號可綁訂閱，只顯示容量不顯示升級。
 */
import { onScopeDispose } from 'vue'
import { auth } from '@legacy/config/firebase'
import { featureLog } from '@legacy/utils/featureLog'

const CHECKOUT_URL = import.meta.env.VITE_LS_CHECKOUT_URL as string | undefined

const { plan, loading, refresh } = usePlan()

let stopFocusLoop: (() => void) | null = null
onScopeDispose(() => stopFocusLoop?.())

function startFocusRefresh() {
  stopFocusLoop?.()
  const deadline = Date.now() + 30 * 60_000
  const onFocus = async () => {
    if (Date.now() > deadline) return stop()
    if ((await refresh()) === 'pro') stop()
  }
  const stop = () => {
    window.removeEventListener('focus', onFocus)
    stopFocusLoop = null
  }
  window.addEventListener('focus', onFocus)
  stopFocusLoop = stop
}

function handleUpgrade() {
  const user = auth.currentUser
  if (!user || !CHECKOUT_URL) return
  featureLog('billing', 'upgrade_click', { uid: user.uid })
  const url = new URL(CHECKOUT_URL)
  url.searchParams.set('checkout[custom][uid]', user.uid)
  if (user.email) url.searchParams.set('checkout[email]', user.email)
  window.open(url.toString(), '_blank', 'noopener')
  startFocusRefresh()
}

const canUpgrade = () =>
  Boolean(CHECKOUT_URL && auth.currentUser && !auth.currentUser.isAnonymous)
</script>

<template>
  <p v-if="!loading" class="plan-capacity" data-testid="plan-capacity">
    <template v-if="plan === 'pro'">
      <span class="plan-capacity__badge">Pro</span> 房間上限 10 人
    </template>
    <template v-else>
      Free 方案 · 房間上限 5 人
      <button
        v-if="canUpgrade()"
        type="button"
        class="plan-capacity__upgrade"
        data-testid="upgrade-pro"
        @click="handleUpgrade"
      >
        升級 Pro 開 10 人房
      </button>
    </template>
  </p>
</template>

<style scoped>
.plan-capacity {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-text-secondary, #8e8e93);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.plan-capacity__badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: linear-gradient(135deg, #af52de, #5856d6);
  color: #fff;
  font-weight: 600;
  font-size: 0.72rem;
}
.plan-capacity__upgrade {
  border: none;
  background: none;
  color: var(--color-accent, #007aff);
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
</style>
