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
import { CourierStore, DEFAULT_COURIER_CONFIG } from '@legacy/core/relay/CourierStore'
import { getCourierReplicaStore } from '@legacy/services/CourierReplicaStore'
import {
  CourierServer,
  CourierClient,
  buildRoomStore,
  runCourierBackup,
  type CourierBackupDeps,
  type MemberCreditConfig,
} from '@legacy/core/relay/CourierService'
import { FirestoreRelayDirectory } from '@legacy/core/relay/FirestoreRelayDirectory'
import { IdentityManager } from '@legacy/core/mesh/IdentityManager'
import { signTombstone } from '@legacy/core/relay/TombstoneCrypto'
import { ecdsaSigner } from '@legacy/core/relay/CourierReceipts'
import { CourierIOUBook } from '@legacy/core/incentive/CourierIOU'
import { getCourierIOUReplicaStore } from '@legacy/services/CourierIOUReplicaStore'
import {
  RoomAdvertCache,
  attachRoomDirectory,
  buildRoomAdvert,
  mergeAnnounceSet,
  type RoomAdvert,
  type RoomDirBus,
} from '@legacy/core/relay/RoomDirectoryGossip'
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
  roomdir?: Record<string, unknown>
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
  let iouBook: CourierIOUBook | null = null
  let memberCredit: MemberCreditConfig | undefined
  let identityReady: Promise<void> = Promise.resolve()
  const servers: CourierServer[] = []
  const clientCache = new Map<string, CourierClient>() // courierUid → client（避免每 tick 累積訂閱）

  // ── 房間目錄 P2P 廣播（去中心化大廳第一片）──────────────────────────────
  // 騎在既有 relay bus 上（ns='roomdir'，同 courier 的掛法，零新傳輸）。
  // 來源由 dashboard 注入（我的公開房）；快取給 dashboard 顯示「P2P 發現的房間」。
  const roomAdvertCache = new RoomAdvertCache()
  let advertSource: (() => Array<{ roomId: string; roomName: string; participantCount: number }>) | null = null
  const roomDirDetachers: Array<() => void> = []

  /**
   * announce 集合 = 我的公開房（現簽）+ 快取裡別人的廣告（原簽轉發 → 多跳傳播，
   * 兩跳外的節點也看得到）。身分未就緒/無來源時仍轉發快取（純 best-effort）。
   */
  async function getAnnounceAdverts(): Promise<RoomAdvert[]> {
    let own: RoomAdvert[] = []
    if (identity && advertSource && nodeId) {
      try {
        const pubKey = await identity.exportPublicKey()
        const sign = ecdsaSigner(identity.getPrivateKey())
        const issuedAt = Date.now()
        own = await Promise.all(
          advertSource().map((r) =>
            buildRoomAdvert(
              {
                roomId: r.roomId,
                roomName: r.roomName,
                ownerUid: currentUid,
                participantCount: r.participantCount,
                issuedAt,
                nodeId,
                pubKey,
              },
              sign
            )
          )
        )
      } catch {
        own = []
      }
    }
    return mergeAnnounceSet(own, roomAdvertCache.list())
  }

  /** 把房間目錄協議掛上一條 relay bus（listening 與 outbound 皆掛；同 bus 只掛一次）。 */
  const roomDirAttached = new WeakSet<object>()
  function attachRoomDir(bus: RoomDirBus, uid: string) {
    if (roomDirAttached.has(bus as object)) return
    roomDirAttached.add(bus as object)
    roomDirDetachers.push(
      attachRoomDirectory({ bus, cache: roomAdvertCache, localUid: uid, getLocalAdverts: getAnnounceAdverts })
    )
  }

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
    attachRoomDir(bus, uid) // outbound 連線也交換房間目錄（clientCache 保證每信使只掛一次）
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
    // 代管密文以 IndexedDB 鏡像，跨 reload 存活（ADR-0024 收官）；無持久層則純記憶體。
    courierStore = new CourierStore(DEFAULT_COURIER_CONFIG, undefined, getCourierReplicaStore() ?? undefined)
    void courierStore.hydrate() // 重載後把先前代管的密文載回，回線可補齊
    directory = new FirestoreRelayDirectory(uid)

    // 信使角色：對每個來連掛 CourierServer。身分與欠條簿未就緒就不提供寄存，避免免費 fail-open。
    stopListen = connector.startListening((conn) => {
      void waitBus(conn).then(async (bus) => {
        if (!bus || !courierStore) return
        await identityReady // waitBus 通常已數秒，身分早就緒；保險同步
        if (!iouBook) return
        const server = new CourierServer(bus, courierStore, uid, undefined, undefined, iouBook)
        server.start()
        servers.push(server)
        attachRoomDir(bus, uid) // 同一條 bus 疊房間目錄（ns='roomdir'）
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
      // Spec 001 實作期修訂：寄存經濟採「有明確對象的欠條」，不是全域 coin 餘額。
      // 每個信使維護自己持有的債權簿；成員用 mesh 身分簽報價欠條。
      try {
        const pubKey = await identity.exportPublicKey()
        const sign = ecdsaSigner(identity.getPrivateKey())
        iouBook = new CourierIOUBook(
          nodeId, sign, undefined, undefined, getCourierIOUReplicaStore() ?? undefined, pubKey
        )
        await iouBook.hydrate()
        memberCredit = { nodeId, pubKey, sign }
      } catch {
        return // 身分/欠條簿失敗 → 不提供寄存，避免繞過 per-發票人額度
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
    // 房間目錄（Spec 006 T2：dashboard 顯示已砍，機制照跑）：e2e 改由此斷言傳播結果
    w.__nerilo_test__.roomdir = {
      list: () => roomAdvertCache.list(),
    }
    w.__nerilo_test__.relay = {
      connectToRelayNode: async (courierUid: string) => {
        const conn = await connector!.connectToRelayNode(courierUid)
        // outbound 也交換房間目錄（production 路徑在 openClient 掛；此為 e2e 直連路徑）
        void waitBus(conn).then((bus) => { if (bus) attachRoomDir(bus, uid) })
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
      // E2E：等代管密文的耐久寫入落定（reload 前確保已持久化）。
      flushCourier: async () => { await courierStore?.flush() },
      // E2E 欠條：本信使持有某發票人的未結債權與剩餘授信。
      iouOutstanding: async (issuerNodeId: string) => {
        await identityReady
        return iouBook?.outstanding(issuerNodeId) ?? 0
      },
      iouAvailableCredit: async (issuerNodeId: string) => {
        await identityReady
        return iouBook?.availableCredit(issuerNodeId) ?? 0
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
    for (const d of roomDirDetachers) {
      try { d() } catch { /* detach 失敗不擋 stop */ }
    }
    roomDirDetachers.length = 0
    for (const s of servers) s.stop()
    servers.length = 0
    for (const c of clientCache.values()) c.stop()
    clientCache.clear()
    if (backupTimer) {
      clearInterval(backupTimer)
      backupTimer = null
    }
    memberCredit = undefined
    iouBook = null
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

  return {
    start,
    stop,
    tombstoneRoom,
    /** dashboard 注入「我要廣播的公開房」來源（只給公開、非 closed 的房）。 */
    setRoomAdvertSource(fn: () => Array<{ roomId: string; roomName: string; participantCount: number }>) {
      advertSource = fn
    },
    /** P2P 發現的公開房（驗簽後快取）；onChange 供 UI 接反應式。 */
    roomDirectory: {
      list: () => roomAdvertCache.list(),
      onChange: (l: () => void) => roomAdvertCache.onChange(l),
    },
  }
}
