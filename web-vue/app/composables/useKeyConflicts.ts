import { ref, onBeforeUnmount } from 'vue'

/**
 * 同代異鑰衝突的 UI 訂閱（Spec 022 C3）。輪詢 MeshChatService.getKeyConflicts()
 * （2s，對齊聊天頁既有狀態輪詢節奏），透出「有衝突」與「換代請求已達上限」兩個事實。
 * 常駐橫幅語義：衝突存在期間持續顯示；協調器換代收斂後新訊息恢復可讀，
 * 但歷史衝突 epoch 的部分訊息可能永久無法解讀（誠實告知，不假裝自癒）。
 */
export interface KeyConflictSource {
  getKeyConflicts?: () => { epochs: number[]; requestLimitReached: boolean }
}

export function useKeyConflicts(getSvc: () => KeyConflictSource | null) {
  const hasKeyConflict = ref(false)
  const conflictLimitReached = ref(false)
  const timer = setInterval(() => {
    const st = getSvc()?.getKeyConflicts?.()
    if (!st) return
    hasKeyConflict.value = st.epochs.length > 0
    conflictLimitReached.value = st.requestLimitReached
  }, 2000)
  onBeforeUnmount(() => clearInterval(timer))
  return { hasKeyConflict, conflictLimitReached }
}
