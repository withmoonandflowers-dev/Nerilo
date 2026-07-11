/**
 * useRelayTestHook — P4-B 陌生節點連線的 E2E 測試掛鉤（test mode only）
 *
 * 僅在 test mode（window.__nerilo_test__ 存在）掛載：建一個 RelayConnector（綁本節點
 * firebase uid，站級 signaling 用）、startListening（本節點可接受來連），並把驅動介面
 * 掛到 window.__nerilo_test__.relay 供 Playwright 驅動。
 *
 * 刻意 test-only：production 不做「自動連上所有在線節點」（premature + O(n²)，
 * ADR-0023 的 relay 連線該按需發生，屬 P4-C）。這裡只為 E2E 證明「傳輸真的通」。
 */
import { RelayConnector } from '@legacy/core/relay/RelayConnector'

interface TestHook {
  relay?: {
    connectToRelayNode: (ownerUid: string) => Promise<void>
    states: () => string[]
    activeCount: () => number
  }
}

export function useRelayTestHook() {
  let connector: RelayConnector | null = null
  let stopListen: (() => void) | null = null

  function start(uid: string) {
    const w = window as unknown as { __nerilo_test__?: TestHook }
    if (!w.__nerilo_test__) return // 非 test mode → 不掛（production 零影響）
    if (connector) return
    connector = new RelayConnector(uid)
    stopListen = connector.startListening()
    w.__nerilo_test__.relay = {
      connectToRelayNode: async (ownerUid: string) => {
        await connector!.connectToRelayNode(ownerUid)
      },
      states: () => connector!.states(),
      activeCount: () => connector!.activeCount(),
    }
  }

  async function stop() {
    stopListen?.()
    stopListen = null
    await connector?.closeAll()
    connector = null
    const w = window as unknown as { __nerilo_test__?: TestHook }
    if (w.__nerilo_test__) delete w.__nerilo_test__.relay
  }

  return { start, stop }
}
