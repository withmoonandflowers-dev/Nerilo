/**
 * 明文送出阻斷式確認（ADR-0026 R2 fail-visible／Spec 012 Q2）。
 *
 * 降級「定局」的房間（真明文房，或金鑰交換逾時衍生為 plaintext）送訊前必須
 * 使用者明確確認，預設拒送。支援兩個入口：
 *  - 新訊息（handleSend pre-check）：攔下 → 確認後以新 id 送出；取消把內容還回輸入框。
 *  - 重送失敗訊息（含出口閘逾時攔下的 sending→failed 氣泡）：攔下 → 確認後沿用
 *    原訊息 id（去重收斂）；取消不動輸入框（氣泡仍在，可再重送）。
 * 確認後的送出走 allowDegraded=true（MeshChatService 出口閘的顯式降級參數）。
 */
import { ref, computed, type Ref } from 'vue'
import { sendDecisionFor, type EncryptionState } from '@legacy/features/chat/encryptionGate'

export function usePlaintextConfirm(opts: {
  encryptionState: Ref<EncryptionState>
  /** 確認後的實際送出（allowDegraded 恆為 true 由呼叫端帶入） */
  send: (content: string, existingId: string | undefined, allowDegraded: true) => Promise<void> | void
  /** 取消「新訊息」確認時把內容還回輸入框（避免使用者白打） */
  restoreInput: (content: string) => void
}) {
  /** 待確認內容；非 null 時顯示阻斷式警告 bar。 */
  const plaintextPending = ref<string | null>(null)
  /** 來自「重送」時的原訊息 id（null＝新訊息）。 */
  const resendId = ref<string | null>(null)

  const e2eeLabel = computed(() =>
    opts.encryptionState.value === 'encrypted' ? '端對端加密'
      : opts.encryptionState.value === 'exchanging' ? '金鑰交換中…'
      : '未加密（此房無法端對端加密）'
  )

  /** 送出前攔檢：降級定局 → 進入確認流並回 true（呼叫端直接 return）。 */
  function interceptSend(content: string, existingId?: string): boolean {
    if (sendDecisionFor(opts.encryptionState.value) !== 'confirm-plaintext') return false
    plaintextPending.value = content
    resendId.value = existingId ?? null
    return true
  }

  async function confirmPlaintextSend() {
    const raw = plaintextPending.value
    const id = resendId.value
    plaintextPending.value = null
    resendId.value = null
    if (raw) await opts.send(raw, id ?? undefined, true)
  }

  function cancelPlaintextSend() {
    if (plaintextPending.value && !resendId.value) opts.restoreInput(plaintextPending.value)
    plaintextPending.value = null
    resendId.value = null
  }

  return { plaintextPending, e2eeLabel, interceptSend, confirmPlaintextSend, cancelPlaintextSend }
}
