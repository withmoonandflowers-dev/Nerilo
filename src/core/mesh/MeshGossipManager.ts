import { IdentityManager } from './IdentityManager';
import { SecurityManager } from './SecurityManager';
import { MeshTopologyManager } from './MeshTopologyManager';
import { GossipMessageHandler } from './GossipMessageHandler';
import { RoomService } from '../../services/RoomService';
import { auth } from '../../config/firebase';
import type { GossipMessage } from '../../types';

/**
 * Mesh Gossip 管理器
 * 整合所有 Mesh 相關功能的主管理器
 */
export class MeshGossipManager {
  private identityManager: IdentityManager;
  private securityManager: SecurityManager;
  private topologyManager: MeshTopologyManager | null = null;
  private messageHandler: GossipMessageHandler | null = null;
  private initialized = false;
  private neighborCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private roomId: string) {
    this.identityManager = new IdentityManager();
    this.securityManager = new SecurityManager();
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn('[MeshGossipManager] Already initialized');
      return;
    }

    console.log('[MeshGossipManager] Initializing', { roomId: this.roomId });

    try {
      // 1. 建立身分
      await this.identityManager.initialize();
      const userId = this.identityManager.getUserId();
      const pubKey = await this.identityManager.exportPublicKey();

      // 2. 註冊身分到 Firestore
      const firebaseUid = auth.currentUser?.uid;
      if (!firebaseUid) {
        throw new Error('User not authenticated');
      }

      await RoomService.updateMeshIdentity(this.roomId, firebaseUid, userId, pubKey);
      console.log('[MeshGossipManager] Identity registered', {
        roomId: this.roomId,
        firebaseUid,
        userId,
      });

      // 3. 初始化拓撲管理器
      this.topologyManager = new MeshTopologyManager(
        this.roomId,
        userId,
        firebaseUid
      );

      // 4. 初始化訊息處理器
      this.messageHandler = new GossipMessageHandler(
        this.roomId,
        userId,
        this.identityManager,
        this.securityManager,
        this.topologyManager
      );

      // 5. 初始化拓撲（建立鄰居連線）
      if (this.topologyManager) {
        await this.topologyManager.initialize();
        
        // 設置鄰居連線的訊息監聽（在連線建立後）
        this.setupNeighborMessageHandlers();
      }

      this.initialized = true;
      console.log('[MeshGossipManager] Initialization completed', {
        roomId: this.roomId,
        userId,
        neighborCount: this.topologyManager?.getNeighborCount() || 0,
      });
    } catch (error) {
      console.error('[MeshGossipManager] Initialization failed', {
        roomId: this.roomId,
        error,
      });
      throw error;
    }
  }

  /**
   * 設置鄰居連線的訊息監聽
   */
  private setupNeighborMessageHandlers(): void {
    if (!this.topologyManager || !this.messageHandler) return;

    // 每 2 秒掃描鄰居列表，為新加入的鄰居設置訊息監聽
    // （MeshConnection.onMessage 內部去重，多次設置不會重複觸發）
    this.neighborCheckInterval = setInterval(() => {
      if (!this.topologyManager || !this.messageHandler) return;

      const neighbors = this.topologyManager.getNeighbors();
      neighbors.forEach(neighbor => {
        neighbor.onMessage(async (message: GossipMessage) => {
          if (this.messageHandler) {
            await this.messageHandler.handleReceivedMessage(
              message,
              neighbor.getId()
            );
          }
        });
      });
    }, 2000);
  }

  /**
   * 發送訊息
   */
  async sendMessage(content: string): Promise<void> {
    if (!this.initialized || !this.messageHandler) {
      throw new Error('MeshGossipManager not initialized. Call initialize() first.');
    }
    return await this.messageHandler.sendMessage(content);
  }

  /**
   * 監聽訊息
   */
  onMessage(listener: (message: GossipMessage) => void): () => void {
    if (!this.messageHandler) {
      throw new Error('MeshGossipManager not initialized. Call initialize() first.');
    }
    return this.messageHandler.onMessage(listener);
  }

  /**
   * 獲取連線狀態
   */
  getConnectionState(): {
    neighborCount: number;
    totalNeighbors: number;
    isConnected: boolean;
  } {
    if (!this.topologyManager) {
      return {
        neighborCount: 0,
        totalNeighbors: 0,
        isConnected: false,
      };
    }

    const neighbors = this.topologyManager.getNeighbors();
    const connectedNeighbors = neighbors.filter(
      n => n.getState() === 'connected'
    );

    return {
      neighborCount: connectedNeighbors.length,
      totalNeighbors: neighbors.length,
      isConnected: connectedNeighbors.length > 0,
    };
  }

  /**
   * 檢查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 清理資源
   */
  async cleanup(): Promise<void> {
    if (this.neighborCheckInterval) {
      clearInterval(this.neighborCheckInterval);
      this.neighborCheckInterval = null;
    }
    if (this.topologyManager) {
      await this.topologyManager.cleanup();
    }
    this.topologyManager = null;
    this.messageHandler = null;
    this.initialized = false;
    console.log('[MeshGossipManager] Cleaned up', { roomId: this.roomId });
  }
}
