/**
 * useCourierNode — 盲信使的 production 節點整合（ADR-0023 P4-C app 觸發 / ADR-0024）
 *
 * dashboard 掛載期間，讓本節點同時扮演盲信使協議的兩端（預設參與，ADR-0024 Decision 3.4）：
 *  - 信使角色（always-on）：RelayConnector.startListening 接受陌生節點來連，對每條 relay
 *    通道掛 CourierServer（跑在 P2PChannelBus，ns='courier'），把寄存紀錄存進共用 CourierStore。
 *  - 成員角色（背景）：週期性 runCourierBackup —發現一個線上信使 → 對「我持有紀錄的每一房」
 *    做一輪 anti-entropy 對帳（推我有信使缺的、收信使有我缺的並落地 IndexedDB）。
 *
 * 預設參與、可關：localStorage `nerilo.courier.enabled`（預設 true）；關閉則兩端皆不啟。
 * 誠實邊界：這是「開著頁面才在幫忙」——關頁即停（對齊 ADR-0024 文案）。全程 best-effort，
 * 任一步失敗靜默降級，不影響 dashboard/聊天主路徑。
 *
 * test mode（window.__nerilo_test__ 存在）額外暴露驅動介面供 Playwright 做確定性 E2E：
 * connectToRelayNode / states / depositAndPull / reconcile / courierStats，及 backup.seedRecord/runOnce。
 */
import { RelayConnector, type RelayConnLike } from '@legacy/core/relay/RelayConnector'
import { CourierStore } from '@legacy/core/relay/CourierStore'
import {
  CourierServer,
  CourierClient,
  buildRoomStore,
  runCourierBackup,
  type CourierBackupDeps,
} from '@legacy/core/relay/CourierService'
import { FirestoreRelayDirectory } from '@legacy/core/relay/FirestoreRelayDirectory'
import { IdentityManager } from '@legacy/core/mesh/IdentityManager'
import { getGossipReplicaStore } from '@legacy/services/GossipReplicaStore'
import type { GossipMessage } from '@legacy/types'

const BACKUP_INTERVAL_MS = 30_000
const COURIER_ENABLED_KEY = 'nerilo.courier.enabled'

/** 預設參與；只有明確存 'false' 才關閉（ADR-0024 Decision 3.4）。 */
function courierEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(COURIER_ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

const CONNECT_TIMEOUT_MS = 30_000
const MAX_COURIER_CANDIDATES = 4

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

/**
 * 等連線真的到 'connected'（DataChannel 開）。initiator 的 bus 在 open 前就存在，
 * 光有 bus 不代表對端可達——陳舊/崩潰的信使名冊條目連得上 signaling 但 DataChannel
 * 永不開。故備份用連線狀態當可達性閘門。逾時（沒連上）回 false。
 */
async function waitConnected(conn: RelayConnLike, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (conn.getState() === 'connected') return true
    if (conn.getState() === 'failed' || conn.getState() === 'closed') return false
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

interface TestHook {
  relay?: Record<string, unknown>
  backup?: Record<string, unknown>
}

export function useCourierNode() {
  let connector: RelayConnector | null = null
  let stopListen: (() => void) | null = null
  let courierStore: CourierStore | null = null
  let directory: FirestoreRelayDirectory | null = null
  let nodeId = ''
  let backupTimer: ReturnType<typeof setInterval> | null = null
  const servers: CourierServer[] = []
  const clientCache = new Map<string, CourierClient>() // courierUid → client（避免每 tick 累積訂閱）

  /**
   * 對某信使開一條 courier client。requireConnected=true 時（背景備份用）等連線真的到
   * 'connected' 才回，藉此濾掉陳舊/不可達的名冊條目；false 時（test-hook 對已知在線信使）
   * 只等 bus 即可，較快。快取重用（同連線同 client，避免每次累積訂閱）。
   */
  async function openClient(
    uid: string,
    courierUid: string,
    requireConnected = false
  ): Promise<CourierClient | null> {
    const cached = clientCache.get(courierUid)
    if (cached) return cached
    const conn = await connector!.connectToRelayNode(courierUid)
    if (requireConnected) {
      if (!(await waitConnected(conn))) return null // 不可達候選 → 換下一個
    }
    const bus = await waitBus(conn)
    if (!bus) return null
    // 4s 逾時：配合 runCourierBackup / depositAndPull 的重試跨越「信使伺服器尚未掛上」視窗。
    const client = new CourierClient(bus, uid, 4_000)
    client.start()
    clientCache.set(courierUid, client)
    return client
  }

  /** 發現候選信使（線上、非自己）的 firebase uid，新鮮者優先，上限 N（容忍陳舊條目）。 */
  async function discoverCourierUids(uid: string): Promise<string[]> {
    if (!directory) return []
    const anns = await directory.query({ excludeNodeId: nodeId })
    const uids: string[] = []
    for (const a of anns) {
      if (a.ownerUid && a.ownerUid !== uid && !uids.includes(a.ownerUid)) uids.push(a.ownerUid)
      if (uids.length >= MAX_COURIER_CANDIDATES) break
    }
    return uids
  }

  /** 組 backup deps（真實作）。persistence 不可用（無 IndexedDB）→ null。 */
  function backupDeps(uid: string): CourierBackupDeps | null {
    const persistence = getGossipReplicaStore()
    if (!persistence) return null
    return {
      listRooms: () => persistence.listRooms(),
      loadRoom: (roomId) => persistence.loadRoom(roomId),
      saveRecord: (roomId, m) => persistence.saveRecord(roomId, m),
      discoverCourierUids: () => discoverCourierUids(uid),
      openClient: (courierUid) => openClient(uid, courierUid, true), // 背景備份：等 connected
    }
  }

  function start(uid: string) {
    if (connector) return
    if (!courierEnabled()) return // opt-out：兩端皆不啟
    connector = new RelayConnector(uid)
    courierStore = new CourierStore()
    directory = new FirestoreRelayDirectory(uid)

    // 信使角色：對每個來連掛 CourierServer。
    stopListen = connector.startListening((conn) => {
      void waitBus(conn).then((bus) => {
        if (!bus || !courierStore) return
        const server = new CourierServer(bus, courierStore, uid)
        server.start()
        servers.push(server)
      })
    })

    // 成員角色：解出 nodeId 後啟動週期備份。
    void (async () => {
      try {
        const im = new IdentityManager()
        await im.initialize()
        nodeId = im.getUserId()
      } catch {
        return // 無身分 → 不備份（信使角色仍在）
      }
      const deps = backupDeps(uid)
      if (!deps) return // 無持久層 → 不備份
      backupTimer = setInterval(() => {
        void runCourierBackup(deps).catch(() => undefined)
      }, BACKUP_INTERVAL_MS)
    })()

    exposeTestHook(uid)
  }

  /** test mode：暴露確定性驅動介面（production 無 __nerilo_test__ → 不暴露）。 */
  function exposeTestHook(uid: string) {
    const w = globalThis as unknown as { __nerilo_test__?: TestHook }
    if (!w.__nerilo_test__) return
    w.__nerilo_test__.relay = {
      connectToRelayNode: async (courierUid: string) => {
        await connector!.connectToRelayNode(courierUid)
      },
      states: () => connector!.states(),
      activeCount: () => connector!.activeCount(),
      courierStats: () => courierStore!.stats(),
      depositAndPull: async (courierUid: string, record: GossipMessage) => {
        const client = await openClient(uid, courierUid)
        if (!client) throw new Error('relay bus not ready')
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
      reconcile: async (courierUid: string, roomId: string, localRecords: GossipMessage[]) => {
        const client = await openClient(uid, courierUid)
        if (!client) throw new Error('relay bus not ready')
        const localStore = buildRoomStore(localRecords)
        for (let attempt = 0; attempt < 5; attempt++) {
          const received: GossipMessage[] = []
          try {
            const res = await client.reconcile(roomId, localStore, new Map(), (m) => received.push(m))
            return { received, pushed: res.pushed }
          } catch (err) {
            if (attempt === 4) throw err
            await new Promise((r) => setTimeout(r, 500))
          }
        }
        return { received: [], pushed: 0 }
      },
    }
    // 讓 E2E 走真 production backup 路徑（同 runCourierBackup），但確定性觸發（不等 30s interval）。
    w.__nerilo_test__.backup = {
      seedRecord: async (roomId: string, record: GossipMessage) => {
        const persistence = getGossipReplicaStore()
        if (!persistence) throw new Error('no persistence')
        await persistence.saveRecord(roomId, record)
      },
      runOnce: async () => {
        const deps = backupDeps(uid)
        if (!deps) throw new Error('no persistence')
        return runCourierBackup(deps)
      },
      debug: async () => {
        const persistence = getGossipReplicaStore()
        const rooms = persistence ? await persistence.listRooms().catch((e) => `err:${e}`) : 'no-persistence'
        const courierUids = await discoverCourierUids(uid).catch((e) => `err:${e}`)
        return { nodeId, rooms, courierUids }
      },
    }
  }

  async function stop() {
    for (const s of servers) s.stop()
    servers.length = 0
    for (const c of clientCache.values()) c.stop()
    clientCache.clear()
    if (backupTimer) {
      clearInterval(backupTimer)
      backupTimer = null
    }
    stopListen?.()
    stopListen = null
    await connector?.closeAll()
    connector = null
    courierStore = null
    directory = null
    const w = globalThis as unknown as { __nerilo_test__?: TestHook }
    if (w.__nerilo_test__) {
      delete w.__nerilo_test__.relay
      delete w.__nerilo_test__.backup
    }
  }

  return { start, stop }
}
