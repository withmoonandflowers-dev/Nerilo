import { MeshConnection } from './MeshConnection';
import { RoomService } from '../../services/RoomService';

/**
 * Mesh 拓撲管理器
 * 負責管理鄰居連線、節點發現和連線旋轉
 */
export class MeshTopologyManager {
  private neighbors: Map<string, MeshConnection> = new Map();
  private readonly k = 6; // 目標鄰居數量
  private rotationInterval: ReturnType<typeof setInterval> | null = null;
  private rotationStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private identityMap: Map<string, string> = new Map(); // firebaseUid -> userId

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
    console.log('[MeshTopologyManager] Initializing', {
      roomId: this.roomId,
      localUserId: this.localUserId,
      localFirebaseUid: this.localFirebaseUid,
    });
    
    // 等待一下，確保其他節點有時間註冊身分
    // 對於 3 人房間，等待 3 秒；對於 5 人房間，等待 5 秒
    const waitTime = 3000;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // 獲取節點列表（可能需要多次嘗試，最多重試 3 次）
    let candidates = await this.discoverNodes();
    let retryCount = 0;
    const maxRetries = 3;
    
    while (candidates.length === 0 && retryCount < maxRetries) {
      console.log('[MeshTopologyManager] No nodes found, waiting and retrying', {
        roomId: this.roomId,
        retryCount: retryCount + 1,
        maxRetries,
      });
      await new Promise(resolve => setTimeout(resolve, 3000)); // 增加等待時間
      candidates = await this.discoverNodes();
      retryCount++;
    }
    
    if (candidates.length === 0) {
      console.warn('[MeshTopologyManager] No nodes found after retries', {
        roomId: this.roomId,
        retryCount,
      });
      return; // 沒有節點可連線
    }
    
    // 選擇鄰居（最多選擇 min(k, candidates.length) 個）
    const maxNeighbors = Math.min(this.k, candidates.length);
    const selected = await this.selectNeighbors(candidates, maxNeighbors);
    
    console.log('[MeshTopologyManager] Selected neighbors', {
      roomId: this.roomId,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      maxNeighbors,
      selectedUserIds: selected,
    });
    
    // 建立連線（不等待所有連線完成，讓它們非同步建立）
    this.connectToNeighbors(selected).catch(error => {
      console.error('[MeshTopologyManager] Error connecting to neighbors', {
        roomId: this.roomId,
        error,
      });
    });
    
    // 開始連線旋轉（延遲啟動，給連線一些時間建立）
    // 注意：連線建立是非同步的，這裡只是啟動旋轉機制
    this.rotationStartTimeout = setTimeout(() => {
      this.rotationStartTimeout = null;
      if (this.neighbors.size > 0) {
        this.startRotation();
        console.log('[MeshTopologyManager] Rotation started', {
          roomId: this.roomId,
          neighborCount: this.neighbors.size,
        });
      }
    }, 10000); // 延遲到 10 秒後啟動旋轉
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
      const isInitiator = this.localUserId < userId;
      const remoteFirebaseUid = this.getFirebaseUidFromUserId(userId);
      const localFirebaseUid = this.localFirebaseUid;

      if (!remoteFirebaseUid) {
        console.log('[MeshTopologyManager] Remote Firebase UID not found, scheduling retry', {
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

      // 等待連線就緒，失敗時觸發重試
      connection.waitForReady()
        .then(() => {
          // 連線成功，重設重試計數
          this.reconnectAttempts.delete(userId);
          console.log('[MeshTopologyManager] Connection ready', {
            roomId: this.roomId,
            remoteUserId: userId,
          });
        })
        .catch((error) => {
          console.warn('[MeshTopologyManager] Connection not ready, scheduling retry', {
            roomId: this.roomId,
            remoteUserId: userId,
            error,
          });
          // 移除失敗的連線，排程重試
          this.neighbors.delete(userId);
          this.scheduleReconnect(userId);
        });

      this.neighbors.set(userId, connection);

      console.log('[MeshTopologyManager] Initiating connection to neighbor', {
        roomId: this.roomId,
        remoteUserId: userId,
        remoteFirebaseUid,
        isInitiator,
      });
    } catch (error) {
      console.warn('[MeshTopologyManager] Failed to connect to neighbor, scheduling retry', {
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
      console.warn('[MeshTopologyManager] Max reconnect attempts reached, giving up', {
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

    console.log('[MeshTopologyManager] Scheduling reconnect', {
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
    console.log('[MeshTopologyManager] Neighbor disconnected', {
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
          console.log('[MeshTopologyManager] No meshIdentities yet, participants may still be registering', {
            roomId: this.roomId,
            participants: room.participants.length,
          });
        }
      }
    } catch (error) {
      console.warn('[MeshTopologyManager] Failed to get room from Firestore', { error });
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
   * 清理資源
   */
  async cleanup(): Promise<void> {
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
        console.error('[MeshTopologyManager] Error closing neighbor', { error });
      })
    );

    await Promise.allSettled(closePromises);
    this.neighbors.clear();
    this.identityMap.clear();
  }
}
