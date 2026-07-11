/**
 * useRelayTestHook — P4-B/P4-C 陌生節點連線 + 盲信使寄存的 E2E 測試掛鉤（test mode only）
 *
 * 僅在 test mode（window.__nerilo_test__ 存在）掛載：
 *  - RelayConnector：本節點可主動連（connectToRelayNode）也可接受來連（startListening）。
 *  - 中繼方角色：對每個來連，等 DataChannel 就緒後掛 CourierServer（跑在該 relay 通道的
 *    P2PChannelBus 上，ns='courier'），把寄存紀錄存進共用 CourierStore。
 *  - 成員方角色：depositAndPull(courierUid, record) → 連上信使、寄存、再取回，證明真通道往返。
 *
 * 刻意 test-only：production 的 relay 連線/寄存該按需觸發（P4-C.3 app 整合），不在此檔決定。
 * 這裡只為 E2E 證明「密文寄存 → 代管 → 取回」在真實 WebRTC relay 通道上成立。
 */
import { RelayConnector, type RelayConnLike } from '@legacy/core/relay/RelayConnector'
import { CourierStore } from '@legacy/core/relay/CourierStore'
import { CourierServer, CourierClient } from '@legacy/core/relay/CourierService'
import type { GossipMessage } from '@legacy/types'

interface TestHook {
  relay?: {
    connectToRelayNode: (ownerUid: string) => Promise<void>
    states: () => string[]
    activeCount: () => number
    depositAndPull: (courierUid: string, record: GossipMessage) => Promise<GossipMessage[]>
  }
}

/** 等連線的 DataChannel bus 就緒（open 前為 null）；逾時回 null。 */
async function waitBus(
  conn: RelayConnLike,
  timeoutMs = 60_000
): Promise<ReturnType<RelayConnLike['getChannelBus']>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bus = conn.getChannelBus()
    if (bus) return bus
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

export function useRelayTestHook() {
  let connector: RelayConnector | null = null
  let stopListen: (() => void) | null = null
  let courierStore: CourierStore | null = null
  const servers: CourierServer[] = []

  function start(uid: string) {
    const w = window as unknown as { __nerilo_test__?: TestHook }
    if (!w.__nerilo_test__) return // 非 test mode → 不掛（production 零影響）
    if (connector) return
    connector = new RelayConnector(uid)
    courierStore = new CourierStore()
    // 中繼方：對每個來連，等通道就緒掛 CourierServer。
    stopListen = connector.startListening((conn) => {
      void waitBus(conn).then((bus) => {
        if (!bus || !courierStore) return
        const server = new CourierServer(bus, courierStore, uid)
        server.start()
        servers.push(server)
      })
    })
    w.__nerilo_test__.relay = {
      connectToRelayNode: async (ownerUid: string) => {
        await connector!.connectToRelayNode(ownerUid)
      },
      states: () => connector!.states(),
      activeCount: () => connector!.activeCount(),
      // 成員方：連上信使 → 寄存 → 取回（證明真通道往返）。
      depositAndPull: async (courierUid: string, record: GossipMessage) => {
        const conn = await connector!.connectToRelayNode(courierUid)
        const bus = await waitBus(conn)
        if (!bus) throw new Error('relay bus not ready')
        // 短逾時 client：deposit 可能在信使掛上 CourierServer 前就到（inbound 不緩衝晚訂閱者），
        // 故重試到 ack 為止（真同步、非塞綠——ack 收到才算存成功）。
        const client = new CourierClient(bus, uid, 3_000)
        client.start()
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await client.deposit(record)
            break
          } catch (err) {
            if (attempt === 4) throw err
            await new Promise((r) => setTimeout(r, 500))
          }
        }
        return client.pull(record.roomId)
      },
    }
  }

  async function stop() {
    for (const s of servers) s.stop()
    servers.length = 0
    stopListen?.()
    stopListen = null
    await connector?.closeAll()
    connector = null
    courierStore = null
    const w = window as unknown as { __nerilo_test__?: TestHook }
    if (w.__nerilo_test__) delete w.__nerilo_test__.relay
  }

  return { start, stop }
}
