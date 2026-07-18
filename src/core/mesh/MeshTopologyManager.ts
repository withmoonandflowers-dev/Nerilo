import { MeshConnection, REJOIN_READY_TIMEOUT_MS } from './MeshConnection';
import type { SignalingFactory } from '../p2p/SignalingTransport';
import { logger } from '../../utils/logger';
import type { IRoomDirectory } from '../../ports/IRoomDirectory';
import { AdaptiveTopologyManager, type TopologyStrategy, type GossipConfig } from './AdaptiveTopologyManager';

/**
 * Mesh 拓撲管理器
 * 負責管理鄰居連線、節點發現和連線旋轉
 * 使用 AdaptiveTopologyManager 根據參與者人數動態調整拓撲策略
 */
export class MeshTopologyManager {
  private neighbors: Map<string, MeshConnection> = new Map();
  private k = 6; // 目標鄰居數量（由 AdaptiveTopologyManager 動態調整）
  private adaptiveTopology = new AdaptiveTopologyManager();
  private currentStrategy: TopologyStrategy = 'full-mesh';
  private currentGossipConfig: GossipConfig = { fanout: 5, ttl: 1 };
  private rotationInterval: ReturnType<typeof setInterval> | null = null;
  private rotationStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private identityMap: Map<string, string> = new Map(); // firebaseUid -> userId
  /** Firestore 實時訂閱（用於動態發現新加入的節點） */
  private discoveryUnsubscribe: (() => void) | null = null;

  /** 重連重試設定 */
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

  /**
   * accept 側讓位餘裕（Spec 011 R-a）：reactive discovery 對「全新成員」的連線
   * 允許上限放寬到 k+SLACK。連線是雙側各自建 MeshConnection 才成形——k 滿的一側
   * 若不建，對側的 offer 無人接、晚到者連不進圖（anti-entropy 收斂前提是連通圖）。
   * 超出 k 的部分由旋轉逐步修剪；≤6 人房 k=6≥n-1，slack 永不觸發、行為不變。
   */
  private static readonly ACCEPT_SLACK = 2;

  /** 追蹤每個 peer 的重試次數，避免無限重試 */
  private reconnectAttempts: Map<string, number> = new Map();
  /** 進行中的重連 timer，cleanup 時需要清除 */
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** 每個 peer 上次觀察到的 joinedAt（session 版本戳），用來偵測「離開再進」 */
  private lastJoinedAt: Map<string, number> = new Map();
  /** firebaseUid → 該成員的介紹人 uid（名冊 introducedBy；Spec 005 發起方裁決用） */
  private introducedByMap: Map<string, string> = new Map();
  /** 被介紹者對非介紹人 pair 的「等介紹人連上」延後次數（每秒一次，有上限保 liveness） */
  private introducedDeferrals: Map<string, number> = new Map();
  private deferralTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  // 12s：warm 收斂殘留未解前，把「邀請流程 warm 失敗時的額外延遲」上界壓小
  // （worst case +12s 才走 cold），典型握手 5-8s 仍涵蓋。
  private static readonly MAX_INTRODUCED_DEFERRALS = 12;

  constructor(
    private roomId: string,
    private localUserId: string,
    private localFirebaseUid: string,
    private directory: IRoomDirectory, // 名冊/發現後端（預設 Firestore；SDK 可注入）
    private signalingFactory?: SignalingFactory, // 省略＝Firestore；SDK 注入自架後端
    /**
     * 首選連線對象 uid（Spec 005 T4：邀請連結指名的介紹人）。被邀請者先連介紹人
     * （bootstrap 第一跳），其餘 pair 才有暖路徑可走。只影響順序，不影響最終拓撲。
     */
    private preferredFirstUid?: string
  ) {}

  /** 把首選對象（介紹人）排到最前（若在候選內）；其餘順序不變。 */
  private prioritize(candidateUserIds: string[]): string[] {
    if (!this.preferredFirstUid) return candidateUserIds;
    const preferredUserId = this.identityMap.get(this.preferredFirstUid);
    if (!preferredUserId || !candidateUserIds.includes(preferredUserId)) return candidateUserIds;
    return [preferredUserId, ...candidateUserIds.filter((id) => id !== preferredUserId)];
  }

  /**
   * 初始化（建立初始鄰居連線）
   */
  async initialize(): Promise<void> {
    logger.info('[MeshTopologyManager] Initializing', {
      roomId: this.roomId,
      localUserId: this.localUserId,
      localFirebaseUid: this.localFirebaseUid,
    });

    // ── 策略：Firestore 實時訂閱 + 反應式連線 ──
    // 不再用固定等待+輪詢，改用 onSnapshot 監聽 meshIdentities 變化。
    // 當新節點註冊身分時，立即嘗試連線，大幅縮短發現延遲。
    //
    // 同時做一次初始讀取：如果此時已有其他節點，立即連線。
    const initialCandidates = await this.discoverNodes();
    if (initialCandidates.length > 0) {
      logger.info('[MeshTopologyManager] Initial candidates found', {
        roomId: this.roomId,
        count: initialCandidates.length,
      });
      const maxNeighbors = Math.min(this.k, initialCandidates.length);
      const selected = this.prioritize(await this.selectNeighbors(initialCandidates, maxNeighbors));
      this.connectToNeighbors(selected).catch(error => {
        logger.error('[MeshTopologyManager] Error connecting to initial neighbors', { error });
      });
    }

    // 啟動 Firestore 實時訂閱：監聽房間 meshIdentities 變化
    this.startReactiveDiscovery();

    // 延遲啟動鄰居旋轉（15 秒後，給所有節點時間建立初始連線）
    this.rotationStartTimeout = setTimeout(() => {
      this.rotationStartTimeout = null;
      if (this.neighbors.size > 0) {
        this.startRotation();
        logger.info('[MeshTopologyManager] Rotation started', {
          roomId: this.roomId,
          neighborCount: this.neighbors.size,
        });
      }
    }, 15000);
  }

  /**
   * 啟動 Firestore 實時訂閱，當新節點加入（註冊 meshIdentity）時自動嘗試連線。
   * 這解決了「所有人同時加入，互相看不到」的競態問題。
   */
  private startReactiveDiscovery(): void {
    this.discoveryUnsubscribe = this.directory.watchIdentities((snapshot) => {
      const newCandidates: string[] = [];

      for (const [firebaseUid, identity] of Object.entries(snapshot.meshIdentities)) {
        if (firebaseUid === this.localFirebaseUid) continue;
        const typedIdentity = identity as { userId: string; pubKey: string; joinedAt: unknown; introducedBy?: string };
        const userId = typedIdentity.userId;

        // 更新 identity map（含介紹人標記，Spec 005 發起方裁決用）
        this.identityMap.set(firebaseUid, userId);
        if (typeof typedIdentity.introducedBy === 'string') {
          this.introducedByMap.set(firebaseUid, typedIdentity.introducedBy);
        }

        // ── 偵測「離開再進」（rejoin）──
        // 對方離開再進時仍用同一持久化身分（userId 不變），故 neighbors.has(userId)
        // 為真、走不到 newCandidates；但本端手上是對方舊 session 的死 pc，對方的全新
        // offer 無處可接 → 卡在連線中。RoomService 每次 (re)join 會把 joinedAt 往上
        // 推，這裡據此偵測：joinedAt 變新且對方已是鄰居 → 拆舊建新，讓兩端各自用全新
        // pc 重新協商。首次觀察（prev===undefined）不算 rejoin。
        const joinedAt = this.parseJoinedAt(typedIdentity.joinedAt);
        const prevJoinedAt = this.lastJoinedAt.get(firebaseUid);
        if (joinedAt !== null) this.lastJoinedAt.set(firebaseUid, joinedAt);
        const rejoined =
          joinedAt !== null &&
          prevJoinedAt !== undefined &&
          joinedAt > prevJoinedAt &&
          this.neighbors.has(userId);
        if (rejoined) {
          logger.info('[MeshTopologyManager] Peer rejoined (session renewed), rebuilding connection', {
            roomId: this.roomId,
            remoteUserId: userId,
          });
          this.reconnectAttempts.delete(userId);
          const t = this.reconnectTimers.get(userId);
          if (t) { clearTimeout(t); this.reconnectTimers.delete(userId); }
          this.connectToSingleNeighbor(userId, REJOIN_READY_TIMEOUT_MS).catch(error => {
            logger.error('[MeshTopologyManager] Rejoin rebuild error', { error });
          });
          continue;
        }

        // 如果這個節點不是現有鄰居，且不在連線中，就加入候選
        if (!this.neighbors.has(userId) && !this.reconnectAttempts.has(userId)) {
          newCandidates.push(userId);
        }
      }

      // Spec 011 R-a：全新成員的連線允許上限放寬到 k+ACCEPT_SLACK（見常數註解）。
      const acceptLimit = this.k + MeshTopologyManager.ACCEPT_SLACK;
      if (newCandidates.length > 0 && this.neighbors.size < acceptLimit) {
        logger.info('[MeshTopologyManager] Reactive discovery: new candidates found', {
          roomId: this.roomId,
          newCandidates,
          currentNeighbors: this.neighbors.size,
        });
        const toConnect = this.prioritize(newCandidates).slice(0, acceptLimit - this.neighbors.size);
        this.connectToNeighbors(toConnect, acceptLimit).catch(error => {
          logger.error('[MeshTopologyManager] Reactive connect error', { error });
        });
      }
    });
  }

  /**
   * 建立鄰居連線（含重試機制）
   * @param limit 連線數上限；預設 k。reactive discovery 接新成員時放寬到
   *   k+ACCEPT_SLACK（Spec 011 R-a），其餘路徑（補滿/旋轉/重連）維持嚴格 k。
   */
  async connectToNeighbors(targetUserIds: string[], limit: number = this.k): Promise<void> {
    for (const userId of targetUserIds) {
      if (this.neighbors.size >= limit) break;
      if (this.neighbors.has(userId)) continue;
      if (userId === this.localUserId) continue;

      await this.connectToSingleNeighbor(userId);
    }
  }

  /**
   * 連線到單一鄰居，失敗時排程指數退避重試。
   * readyTimeoutMs 供 rejoin 首次重建傳較短逾時（快速讓乾淨重試接手）；退避重試不帶，
   * 回到 MeshConnection 預設的耐心 30s。
   */
  private async connectToSingleNeighbor(userId: string, readyTimeoutMs?: number): Promise<void> {
    try {
      // ── 防止資源洩漏：若已有連線物件，先關閉它 ──
      const existing = this.neighbors.get(userId);
      if (existing) {
        logger.info('[MeshTopologyManager] Closing existing connection before reconnect', {
          roomId: this.roomId,
          remoteUserId: userId,
        });
        this.neighbors.delete(userId);
        await existing.close().catch(() => {});
      }

      const remoteFirebaseUid = this.getFirebaseUidFromUserId(userId);
      const localFirebaseUid = this.localFirebaseUid;

      if (!remoteFirebaseUid) {
        logger.info('[MeshTopologyManager] Remote Firebase UID not found, scheduling retry', {
          roomId: this.roomId,
          remoteUserId: userId,
        });
        this.scheduleReconnect(userId);
        return;
      }

      // ── 發起方裁決（Spec 005：介紹加入的 warm 決定性）────────────────────
      // 預設＝userId 字典序。介紹情境覆寫：**被介紹者發起**其非介紹人 pair——
      // 只有它確知「自己與介紹人的鏈路」何時就緒（warm offer 此時必可經介紹人
      // 中繼送達）；對向（看到 remote 有 introducedBy 且介紹人非我）首輪讓位等
      // offer——收到 warm offer 時回程 warm 路徑必然已通，answer 也走 warm。
      // 兩側從名冊同一 introducedBy 推導，結論互補、無 glare。liveness：讓位側
      // 若對方遲未 offer，MeshConnection 逾時→重試輪回歸預設順序（cold 兜底）。
      let isInitiator = this.localUserId < userId;
      const remoteIntroducer = this.introducedByMap.get(remoteFirebaseUid);
      const selfIntroduced = !!this.preferredFirstUid;
      if (selfIntroduced && remoteFirebaseUid !== this.preferredFirstUid) {
        isInitiator = true;
        // 延後發起到介紹人連上（每秒重評，有上限）：發起當下 warm 路徑已可用。
        const deferrals = this.introducedDeferrals.get(userId) ?? 0;
        if (!this.isIntroducerConnected() && deferrals < MeshTopologyManager.MAX_INTRODUCED_DEFERRALS) {
          this.introducedDeferrals.set(userId, deferrals + 1);
          if (deferrals === 0) {
            logger.info('[MeshTopologyManager] Introduced-defer：等介紹人連上再發起', {
              roomId: this.roomId, remoteUserId: userId,
            });
          }
          const t = setTimeout(() => {
            this.deferralTimers.delete(t);
            if (this.neighbors.has(userId)) return;
            void this.connectToSingleNeighbor(userId, readyTimeoutMs);
          }, 1_000);
          this.deferralTimers.add(t);
          return;
        }
      } else if (
        remoteIntroducer &&
        remoteIntroducer !== localFirebaseUid &&
        (this.reconnectAttempts.get(userId) ?? 0) === 0
      ) {
        isInitiator = false; // 首輪讓位給被介紹者；重試輪回歸預設順序
      }

      const connection = new MeshConnection(
        this.roomId,
        localFirebaseUid,
        remoteFirebaseUid,
        userId,
        isInitiator,
        readyTimeoutMs,
        this.signalingFactory
      );

      this.neighbors.set(userId, connection);

      logger.info('[MeshTopologyManager] Initiating connection to neighbor', {
        roomId: this.roomId,
        remoteUserId: userId,
        remoteFirebaseUid,
        isInitiator,
      });

      // 等待連線就緒，失敗時先 close 再排程重試
      connection.waitForReady()
        .then(() => {
          // 連線成功，重設重試計數
          this.reconnectAttempts.delete(userId);
          logger.info('[MeshTopologyManager] Connection ready', {
            roomId: this.roomId,
            remoteUserId: userId,
          });
        })
        .catch(async (error) => {
          logger.warn('[MeshTopologyManager] Connection not ready, closing and scheduling retry', {
            roomId: this.roomId,
            remoteUserId: userId,
            error,
          });
          // 只有當 neighbors 中仍是同一個 connection 才清除
          // （可能在等待期間已被新的 connectToSingleNeighbor 呼叫替換）
          if (this.neighbors.get(userId) === connection) {
            this.neighbors.delete(userId);
          }
          await connection.close().catch(() => {});
          this.scheduleReconnect(userId);
        });
    } catch (error) {
      logger.warn('[MeshTopologyManager] Failed to connect to neighbor, scheduling retry', {
        roomId: this.roomId,
        remoteUserId: userId,
        error,
      });
      this.scheduleReconnect(userId);
    }
  }

  /**
   * 以指數退避排程重連
   */
  private scheduleReconnect(userId: string): void {
    const attempts = this.reconnectAttempts.get(userId) ?? 0;
    if (attempts >= MeshTopologyManager.MAX_RECONNECT_ATTEMPTS) {
      logger.warn('[MeshTopologyManager] Max reconnect attempts reached, giving up', {
        roomId: this.roomId,
        remoteUserId: userId,
        attempts,
      });
      this.reconnectAttempts.delete(userId);
      return;
    }

    // 指數退避 + jitter：delay = min(base * 2^attempts + jitter, max)
    // jitter 取 ±10% 避免 thundering herd（#32），原本 jitter 等於 base delay 過大
    const baseDelay = MeshTopologyManager.BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts);
    const jitter = (Math.random() - 0.5) * baseDelay * 0.2;
    const delay = Math.min(baseDelay + jitter, MeshTopologyManager.MAX_RECONNECT_DELAY_MS);

    this.reconnectAttempts.set(userId, attempts + 1);

    logger.info('[MeshTopologyManager] Scheduling reconnect', {
      roomId: this.roomId,
      remoteUserId: userId,
      attempt: attempts + 1,
      maxAttempts: MeshTopologyManager.MAX_RECONNECT_ATTEMPTS,
      delayMs: Math.round(delay),
    });

    // 清除已有的 timer（避免重複排程）
    const existingTimer = this.reconnectTimers.get(userId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(userId);
      // 如果已經有這個鄰居了（可能透過其他路徑連上），跳過
      if (this.neighbors.has(userId)) return;
      // 如果已達上限，跳過
      if (this.neighbors.size >= this.k) return;

      // 重新發現節點以更新 identityMap（peer 可能在等待期間才註冊身分）
      await this.discoverNodes();
      await this.connectToSingleNeighbor(userId);
    }, delay);

    this.reconnectTimers.set(userId, timer);
  }

  /**
   * 解析 joinedAt：RoomService 寫入的是 Date.now() number，但保險起見也接受
   * Firestore Timestamp（{ toMillis() } 或 { seconds }）。無法解析回 null。
   */
  private parseJoinedAt(raw: unknown): number | null {
    if (typeof raw === 'number') return raw;
    if (raw && typeof raw === 'object') {
      const obj = raw as { toMillis?: () => number; seconds?: number };
      if (typeof obj.toMillis === 'function') return obj.toMillis();
      if (typeof obj.seconds === 'number') return obj.seconds * 1000;
    }
    return null;
  }

  /** 介紹人（preferredFirstUid）目前是否已連上（DataChannel 可送）。 */
  private isIntroducerConnected(): boolean {
    if (!this.preferredFirstUid) return false;
    const introducerUserId = this.identityMap.get(this.preferredFirstUid);
    if (!introducerUserId) return false;
    return this.neighbors.get(introducerUserId)?.getState() === 'connected';
  }

  /**
   * 從 userId 獲取 Firebase UID
   */
  private getFirebaseUidFromUserId(userId: string): string | null {
    for (const [firebaseUid, mappedUserId] of this.identityMap.entries()) {
      if (mappedUserId === userId) {
        return firebaseUid;
      }
    }
    return null;
  }

  /**
   * 處理鄰居斷線：先嘗試重連同一 peer，若失敗再補連其他 peer
   */
  async handleNeighborDisconnected(neighborId: string): Promise<void> {
    logger.info('[MeshTopologyManager] Neighbor disconnected', {
      roomId: this.roomId,
      neighborId,
    });

    const neighbor = this.neighbors.get(neighborId);
    if (neighbor) {
      await neighbor.close();
      this.neighbors.delete(neighborId);
    }

    // 先嘗試重連同一 peer（重設重試計數，給它一次新機會）
    this.reconnectAttempts.delete(neighborId);
    this.scheduleReconnect(neighborId);

    // 同時也補連其他 peer，確保鄰居數量充足
    await this.fillNeighbors();
  }

  /**
   * 補滿鄰居
   */
  private async fillNeighbors(): Promise<void> {
    if (this.neighbors.size >= this.k) return;
    
    const candidates = await this.discoverNodes();
    const needed = this.k - this.neighbors.size;
    const selected = await this.selectNeighbors(candidates, needed);
    
    await this.connectToNeighbors(selected);
  }

  /**
   * 開始連線旋轉
   */
  startRotation(): void {
    this.rotationInterval = setInterval(() => {
      this.rotateConnection();
    }, 2 * 60 * 1000); // 2 分鐘
  }

  /**
   * 旋轉一條連線
   */
  private async rotateConnection(): Promise<void> {
    if (this.neighbors.size < this.k) {
      await this.fillNeighbors();
      return;
    }
    
    const neighborsArray = Array.from(this.neighbors.keys());
    const toRemove = neighborsArray[Math.floor(Math.random() * neighborsArray.length)];
    
    const neighbor = this.neighbors.get(toRemove);
    if (neighbor) {
      await neighbor.close();
      this.neighbors.delete(toRemove);
    }
    
    await this.fillNeighbors();
  }

  /**
   * 發現節點
   */
  private async discoverNodes(): Promise<string[]> {
    const discoveredUserIds = new Set<string>();
    
    // 方法 1：從 directory 取名冊（預設 Firestore，SDK 可注入自架後端）
    try {
      const snap = await this.directory.getSnapshot();
      const entries = Object.entries(snap.meshIdentities);
      if (entries.length > 0) {
        for (const [firebaseUid, identity] of entries) {
          if (firebaseUid !== this.localFirebaseUid) {
            discoveredUserIds.add(identity.userId);
            this.identityMap.set(firebaseUid, identity.userId);
            if (typeof identity.introducedBy === 'string') {
              this.introducedByMap.set(firebaseUid, identity.introducedBy);
            }
          }
        }
      } else if (snap.participants.length >= 2) {
        // 還沒有 meshIdentities 但已有參與者：其他人可能還在註冊身分
        logger.info('[MeshTopologyManager] No meshIdentities yet, participants may still be registering', {
          roomId: this.roomId,
          participants: snap.participants.length,
        });
      }
    } catch (error) {
      logger.warn('[MeshTopologyManager] Failed to get room snapshot', { error });
    }
    
    // 方法 2：從現有鄰居獲取他們的鄰居列表（簡化版，暫時不實作）
    
    return Array.from(discoveredUserIds);
  }

  /**
   * 選擇鄰居
   */
  private async selectNeighbors(
    candidates: string[],
    count: number
  ): Promise<string[]> {
    // 過濾掉已經是鄰居的節點
    const available = candidates.filter(
      userId => !this.neighbors.has(userId) && userId !== this.localUserId
    );
    
    // 簡單策略：隨機選擇
    // 未來可以加入連線品質評估
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, available.length));
  }

  /**
   * 獲取所有鄰居
   */
  getNeighbors(): MeshConnection[] {
    return Array.from(this.neighbors.values());
  }

  /**
   * 獲取鄰居數量
   */
  getNeighborCount(): number {
    return this.neighbors.size;
  }

  /**
   * 根據參與者人數更新拓撲策略（Spec 011「只升不降」政策）。
   * 由 MeshGossipManager 在名冊 watch push 時呼叫（人數＝rosterFromRoom 語義）。
   *
   * - 策略 rank 上升 → 整組採納（strategy、k、gossipConfig）。full→partial 時
   *   k 由 6 縮到 max(3,⌈√n⌉) 是設計內縮編，多餘連線由旋轉逐步收斂。
   * - 同 rank → k 與 fanout/ttl 只取 max（partial 區間 7→10 人 k 3→4 單調不縮）。
   * - rank 下降 → 忽略。人數短暫低報（名冊快照落後）不得使運作中房間降級抖動；
   *   多餘連線無正確性代價。淨效果：≤6 人房永遠停在建構預設（k=6/fanout5/ttl1），
   *   既有 2-5 人基線行為不變；第 7 人到場才首次切 partial。
   */
  updateParticipantCount(participantCount: number): void {
    const evaluation = this.adaptiveTopology.evaluateTopology(participantCount);
    const oldK = this.k;
    const oldStrategy = this.currentStrategy;

    if (this.adaptiveTopology.shouldUpgrade(this.currentStrategy, participantCount)) {
      this.currentStrategy = evaluation.strategy;
      this.k = evaluation.targetNeighborCount;
      this.currentGossipConfig = evaluation.gossipConfig;
    } else if (evaluation.strategy === this.currentStrategy) {
      this.k = Math.max(this.k, evaluation.targetNeighborCount);
      this.currentGossipConfig = {
        fanout: Math.max(this.currentGossipConfig.fanout, evaluation.gossipConfig.fanout),
        ttl: Math.max(this.currentGossipConfig.ttl, evaluation.gossipConfig.ttl),
      };
    } else {
      return; // 只升不降：評估結果 rank 較低，忽略
    }

    if (oldStrategy !== this.currentStrategy || oldK !== this.k) {
      logger.info('[MeshTopologyManager] Topology updated', {
        roomId: this.roomId,
        participantCount,
        strategy: this.currentStrategy,
        k: this.k,
        gossipConfig: this.currentGossipConfig,
      });

      // Adjust neighbor count if needed
      if (this.k > oldK) {
        this.fillNeighbors().catch((err) => {
          logger.warn('[MeshTopologyManager] fillNeighbors after upgrade failed', err);
        });
      }
      // full→partial 的 k 縮編：由旋轉逐步收斂（rotateConnection）
    }
  }

  /** Current topology strategy */
  getStrategy(): TopologyStrategy {
    return this.currentStrategy;
  }

  /** 目前的目標鄰居數 k（Spec 011：橋接條件與 UI 覆蓋率的基準值） */
  getTargetNeighborCount(): number {
    return this.k;
  }

  /** Current gossip configuration (fanout + ttl) */
  getGossipConfig(): GossipConfig {
    return this.currentGossipConfig;
  }

  /**
   * 清理資源
   */
  async cleanup(): Promise<void> {
    // 停止 Firestore 實時訂閱
    if (this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe();
      this.discoveryUnsubscribe = null;
    }

    // 清除所有重連/延後 timer
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const timer of this.deferralTimers) clearTimeout(timer);
    this.deferralTimers.clear();
    this.introducedDeferrals.clear();

    if (this.rotationStartTimeout) {
      clearTimeout(this.rotationStartTimeout);
      this.rotationStartTimeout = null;
    }
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = null;
    }

    const closePromises = Array.from(this.neighbors.values()).map(neighbor =>
      neighbor.close().catch(error => {
        logger.error('[MeshTopologyManager] Error closing neighbor', { error });
      })
    );

    await Promise.allSettled(closePromises);
    this.neighbors.clear();
    this.identityMap.clear();
  }
}
