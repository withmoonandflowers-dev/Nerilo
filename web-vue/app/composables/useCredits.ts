/**
 * 點數 × 中繼狀態（ADR-0011/0021 資產接進 Vue）。
 *
 * 誠實原則：只顯示真實發生的事——
 * - 「中繼中 · 累積點數」：有活躍 P2P 連線（在線累積 + 實際中繼都會進帳）。
 * - 「中繼待命中」：在站上但沒有活躍連線（沒有假點數、沒有假動畫）。
 * 全站（無房間）relay overlay 屬 ADR-0021 Phase 2 接線，見設計文件。
 */
import { creditEconomy } from '@legacy/core/incentive/CreditEconomy'

const balance = ref(0)
const relayActive = ref(false)
let subscribed = false

export function useCredits() {
  const { user } = useAuth()

  function ensureInit() {
    if (!user.value) return
    creditEconomy.init(user.value.uid)
    if (!subscribed) {
      subscribed = true
      creditEconomy.subscribe((b) => {
        balance.value = Math.floor(b.balance)
      })
      creditEconomy.getBalance().then((b) => {
        if (b) balance.value = Math.floor(b.balance)
      }).catch(() => {})
    }
  }

  /** 連線活著時呼叫（開始在線累積）；斷線/離房呼叫 stop */
  function startEarning() {
    ensureInit()
    creditEconomy.startEarning()
    relayActive.value = true
  }

  function stopEarning() {
    creditEconomy.stopEarning()
    relayActive.value = false
  }

  return { balance: readonly(balance), relayActive: readonly(relayActive), ensureInit, startEarning, stopEarning }
}
