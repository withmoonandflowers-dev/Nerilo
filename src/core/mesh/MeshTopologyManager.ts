import { MeshConnection } from './MeshConnection';
import { RoomService } from '../../services/RoomService';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';
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

  /** 追蹤每個 peer 的重試次數，避免無限重試 */
  private reconnectAttempts: Map<string, number> = new Map();
  /** 進行中的重連 timer，cleanup 時需要清除 */
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private roomId: string,
    private localUserId: string,
    private localFirebaseUid: string
  ) {}

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
      const selected = await this.selectNeighbors(initialCandidates, maxNeighbors);
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
    const roomRef = doc(db, 'p2pRooms', this.roomId);

    this.discoveryUnsubscribe = onSnapshot(roomRef, (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      if (!data.meshIdentities) return;

      const newCandidates: string[] = [];

      for (const [firebaseUid, identity] of Object.entries(data.meshIdentities)) {
        if (firebaseUid === this.localFirebaseUid) continue;
        const typedIdentity = identity as { userId: string; pubKey: string; joinedAt: unknown };
        const userId = typedIdentity.userId;

        // 更新 identity map
        this.identityMap.set(firebaseUid, userId);

        // 如果這個節點不是現有鄰居，且不在連線中，就加入候選
        if (!this.neighbors.has(userId) && !this.reconnectAttempts.has(userId)) {
          newCandidates.push(userId);
        }
      }

      if (newCandidates.length > 0 && this.neighbors.size < this.k) {
        logger.info('[MeshTopologyManager] Reactive discovery: new candidates found', {
          roomId: this.roomId,
          newCandidates,
          currentNeighbors: this.neighbors.size,
        });
        const toConnect = newCandidates.slice(0, this.k - this.neighbors.size);
        this.connectToNeighbors(toConnect).catch(error => {
          logger.error('[MeshTopologyManager] Reactive connect error', { error });
        });
      }
    }, (error) => {
      logger.warn('[MeshTopologyManager] Reactive discovery error', { error });
    });
  }

  /**
   * 建立鄰居連線（含重試機制）
   */
  async connectToNeighbors(targetUserIds: string[]): Promise<void> {
    for (const userId of targetUserIds) {
      if (this.neighbors.size >= this.k) break;
      if (this.neighbors.has(userId)) continue;
      if (userId === this.localUserId) continue;

      await this.connectToSingleNeighbor(userId);
    }
  }

  /**
   * 連線到單一鄰居，失敗時排程指數退避重試
   */
  private async connectToSingleNeighbor(userId: string): Promise<void> {
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

      const isInitiator = this.localUserId < userId;
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

      const connection = new MeshConnection(
        this.roomId,
        localFirebaseUid,
        remoteFirebaseUid,
        userId,
        isInitiator
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
    
    // 方法 1：從 Firestore 獲取房間參與者和 mesh 身分資訊
    try {
      const room = await RoomService.getRoom(this.roomId, true);
      if (room && room.participants) {
        // 獲取 meshIdentities
        if (room.meshIdentities) {
          for (const [firebaseUid, identity] of Object.entries(room.meshIdentities)) {
            if (firebaseUid !== this.localFirebaseUid) {
              discoveredUserIds.add(identity.userId);
              this.identityMap.set(firebaseUid, identity.userId);
            }
          }
        } else if (room.participants.length >= 2) {
          // 如果還沒有 meshIdentities，但已經有參與者，等待一下
          // 其他參與者可能還在註冊身分
          logger.info('[MeshTopologyManager] No meshIdentities yet, participants may still be registering', {
            roomId: this.roomId,
            participants: room.participants.length,
          });
        }
      }
    } catch (error) {
      logger.warn('[MeshTopologyManager] Failed to get room from Firestore', { error });
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
   * 根據參與者人數更新拓撲策略。
   * 由 MeshGossipManager 在參與者變動時呼叫。
   */
  updateParticipantCount(participantCount: number): void {
    const evaluation = this.adaptiveTopology.evaluateTopology(participantCount);
    const oldK = this.k;
    const oldStrategy = this.currentStrategy;

    this.k = evaluation.targetNeighborCount;
    this.currentStrategy = evaluation.strategy;
    this.currentGossipConfig = evaluation.gossipConfig;

    if (oldStrategy !== evaluation.strategy || oldK !== this.k) {
      logger.info('[MeshTopologyManager] Topology updated', {
        roomId: this.roomId,
        participantCount,
        strategy: evaluation.strategy,
        k: this.k,
        gossipConfig: evaluation.gossipConfig,
      });

      // Adjust neighbor count if needed
      if (this.k > oldK) {
        this.fillNeighbors().catch((err) => {
          logger.warn('[MeshTopologyManager] fillNeighbors after upgrade failed', err);
        });
      }
      // Downgrade: gradually reduce connections (handled by rotation)
    }
  }

  /** Current topology strategy */
  getStrategy(): TopologyStrategy {
    return this.currentStrategy;
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

    // 清除所有重連 timer
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

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
