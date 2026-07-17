/**
 * useNodePresence — 全站節點 presence（ADR-0023 P4-A.2）
 *
 * dashboard 掛載期間週期宣告「本節點在線、可中繼/守護」到 relayDirectory，並查詢
 * 目前線上的其他節點數。這是盲信使的可見前哨:你看得到「還有幾個人一起守護」。
 *
 * 誠實條款:只在非匿名登入且宣告成功時 announcing=true(rules 要求非匿名)；
 * 匿名/被拒/失敗一律靜默降級,不顯示假在線(對齊 dashboard 既有「不做假中繼」原則)。
 * nodeId = mesh userId(hash pubKey),與進房後的 mesh 身分一致。
 */
import { IdentityManager } from '@legacy/core/mesh/IdentityManager'
import { FirestoreRelayDirectory } from '@legacy/core/relay/FirestoreRelayDirectory'

const HEARTBEAT_MS = 5_000

export function useNodePresence() {
  const peerCount = ref(0)
  const announcing = ref(false)
  let directory: FirestoreRelayDirectory | null = null
  let nodeId = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function start(uid: string) {
    if (running) return
    running = true
    try {
      const im = new IdentityManager()
      await im.initialize()
      nodeId = im.getUserId()
      directory = new FirestoreRelayDirectory(uid)
    } catch {
      running = false
      return // 身分/名冊建立失敗 → 不宣告(不顯示假在線)
    }
    const tick = async () => {
      if (!running || !directory) return
      try {
        await directory.announce({ nodeId, announcedAt: Date.now(), capacity: 1 })
        announcing.value = true
      } catch {
        announcing.value = false // 匿名/被 rules 拒 → 不宣告
      }
      try {
        peerCount.value = (await directory.query({ excludeNodeId: nodeId })).length
      } catch {
        peerCount.value = 0
      }
    }
    await tick()
    timer = setInterval(() => void tick(), HEARTBEAT_MS)

    // test mode 曝露（Spec 006 T2：dashboard 的節點數顯示已砍，機制照跑）：
    // e2e 改由此斷言「互相發現」；production 無 __nerilo_test__ → 不暴露。
    const w = globalThis as unknown as { __nerilo_test__?: { presence?: Record<string, unknown> } }
    if (w.__nerilo_test__) {
      w.__nerilo_test__.presence = {
        peerCount: () => peerCount.value,
        announcing: () => announcing.value,
      }
    }
  }

  async function stop() {
    running = false
    announcing.value = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (directory && nodeId) {
      await directory.withdraw(nodeId).catch(() => {})
    }
    directory = null
  }

  return { peerCount: readonly(peerCount), announcing: readonly(announcing), start, stop }
}
