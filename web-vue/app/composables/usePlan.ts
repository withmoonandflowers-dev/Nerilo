/**
 * 訂閱方案 entitlement（ADR-0008，Vue 線）。
 *
 * 真相源是 ID token 的 custom claim `plan`（LS webhook 或 scripts/grant-plan.mjs
 * 經 firebase-admin 寫入）；前端只讀不判權，配額強制在 firestore.rules。
 *
 * claim 更新後 ID token 最長 1 小時才自然輪替，refresh() 強制刷新——
 * 結帳在另一分頁完成，回到本分頁的 focus 時機應呼叫它讓 Pro 即時生效
 * （見 PlanCapacityLine 的 focus 迴圈）。與 React 線 src/hooks/usePlan.ts 同語義。
 */
import { ref, onMounted, onScopeDispose } from 'vue'
import { onIdTokenChanged, type User as FirebaseUser } from 'firebase/auth'
import { auth } from '@legacy/config/firebase'

export type Plan = 'free' | 'pro'

async function readPlan(firebaseUser: FirebaseUser | null): Promise<Plan> {
  if (!firebaseUser || firebaseUser.isAnonymous) return 'free'
  const token = await firebaseUser.getIdTokenResult()
  return token.claims.plan === 'pro' ? 'pro' : 'free'
}

export function usePlan() {
  const plan = ref<Plan>('free')
  const loading = ref(true)

  onMounted(() => {
    const unsubscribe = onIdTokenChanged(auth, async (firebaseUser) => {
      plan.value = await readPlan(firebaseUser)
      loading.value = false
    })
    onScopeDispose(unsubscribe)
  })

  const refresh = async (): Promise<Plan> => {
    const current = auth.currentUser
    if (current) {
      await current.getIdToken(true) // 強制刷新 → 觸發 onIdTokenChanged
    }
    const next = await readPlan(current)
    plan.value = next
    return next
  }

  return { plan, loading, refresh }
}
