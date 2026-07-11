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
  type CourierCreditConfig,
  type MemberCreditConfig,
} from '@legacy/core/relay/CourierService'
import { FirestoreRelayDirectory } from '@legacy/core/relay/FirestoreRelayDirectory'
import { IdentityManager } from '@legacy/core/mesh/IdentityManager'
import { signTombstone } from '@legacy/core/relay/TombstoneCrypto'
import { ecdsaSigner } from '@legacy/core/relay/CourierReceipts'
import { creditEconomy } from '@legacy/core/incentive/CreditEconomy'
import { CreditLedger } from '@legacy/core/incentive/CreditLedger'
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
  let identity: IdentityManager | null = null // 保留供簽墓碑/收據（房籍 pubKey/privKey）
  let currentUid = ''
  let backupTimer: ReturnType<typeof setInterval> | null = null
  let claimTimer: ReturnType<typeof setInterval> | null = null
  let courierCredit: CourierCreditConfig | undefined // 計量設定（身分就緒後建）
  let memberCredit: MemberCreditConfig | undefined
  let identityReady: Promise<void> = Promise.resolve()
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
    // memberCredit（身分就緒後才有）讓成員自動回簽信使起草的收據 → 信使可計點。
    const client = new CourierClient(bus, uid, 4_000, memberCredit)
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

  /**
   * 房間刪除/退出時呼叫：以房籍身分簽一張墓碑，best-effort 廣播給發現的候選信使，
   * 請它們丟掉代管副本（ADR-0024 Decision 3.3）。同時清掉本地持久複本。
   * 全程 best-effort：簽不出/連不上/驗不過都不拋，不擋刪除主流程。
   */
  async function tombstoneRoom(roomId: string): Promise<void> {
    if (!identity || !connector) return
    let tomb
    try {
      const pubKey = await identity.exportPublicKey()
      tomb = await signTombstone(roomId, identity.getPrivateKey(), pubKey)
    } catch {
      return // 簽不出（身分未就緒）→ 放棄廣播
    }
    let candidates: string[] = []
    try {
      candidates = await discoverCourierUids(currentUid)
    } catch {
      /* 無候選 */
    }
    for (const courierUid of candidates) {
      try {
        const client = await openClient(currentUid, courierUid, true)
        if (client) await client.tombstone(roomId, tomb)
      } catch {
        /* 該信使失敗，續下一個 */
      }
    }
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
    currentUid = uid
    connector = new RelayConnector(uid)
    courierStore = new CourierStore()
    directory = new FirestoreRelayDirectory(uid)

    // 信使角色：對每個來連掛 CourierServer（等身分就緒才帶計量設定，才能簽收據賺點）。
    stopListen = connector.startListening((conn) => {
      void waitBus(conn).then(async (bus) => {
        if (!bus || !courierStore) return
        await identityReady // waitBus 通常已數秒，身分早就緒；保險同步
        const server = new CourierServer(bus, courierStore, uid, undefined, courierCredit)
        server.start()
        servers.push(server)
      })
    })

    // 成員角色：解出 nodeId 後建計量設定、啟動週期備份 + 計量。
    identityReady = (async () => {
      try {
        const im = new IdentityManager()
        await im.initialize()
        nodeId = im.getUserId()
        identity = im // 保留供簽墓碑/收據
      } catch {
        return // 無身分 → 不備份/不計量（信使代管角色仍在）
      }
      // 計量設定（ADR-0022）：信使賺點落 CreditEconomy + 可驗帳本；成員回簽。
      // 餘額以 firebase uid 為帳戶鍵（與 useCredits 一致，避免 singleton 被重綁不同 id）；
      // 收據身分用 mesh nodeId（pubKey↔nodeId 綁定、可驗）。同一使用者，兩者指同一實體。
      try {
        const pubKey = await identity.exportPublicKey()
        const sign = ecdsaSigner(identity.getPrivateKey())
        creditEconomy.init(currentUid)
        creditEconomy.attachLedger(new CreditLedger())
        courierCredit = {
          nodeId, pubKey, sign,
          onCredit: (requesterNodeId, bytes) =>
            creditEconomy.recordRelayContribution(requesterNodeId, bytes),
        }
        memberCredit = { nodeId, pubKey, sign }
      } catch {
        /* 計量設定失敗 → 純代管，不計點 */
      }
      const deps = backupDeps(uid)
      if (!deps) return // 無持久層 → 不備份
      backupTimer = setInterval(() => {
        void runCourierBackup(deps).catch(() => undefined)
      }, BACKUP_INTERVAL_MS)
      // 計量：週期性請每條連線的成員回簽代管收據。
      claimTimer = setInterval(() => {
        for (const s of servers) void s.claimCredit().catch(() => undefined)
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
      // E2E：本節點 mesh 身分（senderId），供構造「本人貢獻的紀錄」以驗房籍墓碑。
      myNodeId: () => nodeId,
      // E2E：以本人房籍簽 + 送墓碑給指定信使，回傳 freed（走 CourierClient.tombstone）。
      sendTombstone: async (courierUid: string, roomId: string) => {
        if (!identity) throw new Error('identity not ready')
        const pubKey = await identity.exportPublicKey()
        const tomb = await signTombstone(roomId, identity.getPrivateKey(), pubKey)
        const client = await openClient(uid, courierUid)
        if (!client) throw new Error('relay bus not ready')
        return client.tombstone(roomId, tomb)
      },
      // E2E 計量：本節點（信使）目前餘額 + 帳本完整性（ADR-0022）。
      creditBalance: async () => (await creditEconomy.getBalance())?.balance ?? 0,
      verifyLedger: async () => (await creditEconomy.verifyLedger()).ok,
      // E2E：確定性觸發計量一輪（不等 30s claim interval）。
      claimCreditsNow: async () => {
        await identityReady
        for (const s of servers) await s.claimCredit()
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
    if (claimTimer) {
      clearInterval(claimTimer)
      claimTimer = null
    }
    courierCredit = undefined
    memberCredit = undefined
    stopListen?.()
    stopListen = null
    await connector?.closeAll()
    connector = null
    courierStore = null
    directory = null
    identity = null
    const w = globalThis as unknown as { __nerilo_test__?: TestHook }
    if (w.__nerilo_test__) {
      delete w.__nerilo_test__.relay
      delete w.__nerilo_test__.backup
    }
  }

  return { start, stop, tombstoneRoom }
}
