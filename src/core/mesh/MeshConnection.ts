import { P2PManager } from '../p2p/P2PManager';
import { P2PChannelBus } from '../p2p/P2PChannelBus';
import type { GossipMessage } from '../../types';

/**
 * Mesh 連線包裝類別
 * 封裝與單個鄰居的 P2P 連線
 */
export class MeshConnection {
  private p2pManager: P2PManager;
  private channelBus: P2PChannelBus | null = null;
  private messageListeners: Set<(message: GossipMessage) => void> = new Set();
  private readyPromise: Promise<void>;
  private meshUserId: string; // 用於 Gossip 的 userId

  constructor(
    private roomId: string,
    private localFirebaseUid: string, // 用於 signaling 的 Firebase UID
    private remoteFirebaseUid: string, // 用於 signaling 的 Firebase UID
    meshUserId: string, // 用於 Gossip 的 userId
    isInitiator: boolean
  ) {
    this.meshUserId = meshUserId;
    
    // 使用 Firebase UID 進行 signaling（因為 P2PConnectionManager 依賴它）
    this.p2pManager = new P2PManager(
      roomId,
      localFirebaseUid,
      `mesh-${remoteFirebaseUid}`,
      isInitiator
    );
    
    this.readyPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.p2pManager.initialize();
    
    // 等待 ChannelBus 準備好（增加超時時間，因為 Mesh 連線可能需要更長時間）
    const checkInterval = setInterval(() => {
      const bus = this.p2pManager.getChannelBus();
      if (bus && bus.getReadyState() === 'open') {
        clearInterval(checkInterval);
        this.channelBus = bus;
        this.setupMessageHandlers();
        console.log('[MeshConnection] ChannelBus ready', {
          roomId: this.roomId,
          remoteFirebaseUid: this.remoteFirebaseUid,
          meshUserId: this.meshUserId,
        });
      }
    }, 200); // 每 200ms 檢查一次

    // 超時處理（增加到 30 秒，因為 Mesh 連線建立可能需要更長時間）
    setTimeout(() => {
      clearInterval(checkInterval);
      if (!this.channelBus) {
        console.warn('[MeshConnection] ChannelBus not ready after timeout', {
          roomId: this.roomId,
          remoteFirebaseUid: this.remoteFirebaseUid,
          meshUserId: this.meshUserId,
        });
      }
    }, 30000); // 30 秒超時
  }

  /**
   * 等待連線準備就緒
   */
  async waitForReady(): Promise<void> {
    await this.readyPromise;
    if (!this.channelBus) {
      throw new Error('ChannelBus not ready');
    }
  }

  /**
   * 設置訊息處理器
   */
  private setupMessageHandlers(): void {
    if (!this.channelBus) return;

    this.channelBus.subscribe('gossip', async (envelope) => {
      if (envelope.type === 'GOSSIP_MESSAGE') {
        const message = envelope.payload as GossipMessage;
        this.messageListeners.forEach(listener => {
          try {
            listener(message);
          } catch (error) {
            console.error('[MeshConnection] Error in message listener', { error });
          }
        });
      }
    });
  }

  /**
   * 發送訊息
   */
  async send(message: GossipMessage): Promise<void> {
    await this.waitForReady();
    
    if (!this.channelBus) {
      throw new Error('ChannelBus not available');
    }

    const envelope = {
      v: 1,
      ns: 'gossip',
      type: 'GOSSIP_MESSAGE',
      id: `${Date.now()}-${Math.random()}`,
      ts: Date.now(),
      from: this.localFirebaseUid, // 使用 Firebase UID 進行 envelope
      to: this.remoteFirebaseUid,
      payload: message, // message 本身包含 senderId (userId)
    };

    await this.channelBus.send(envelope);
  }

  /**
   * 監聽訊息
   */
  onMessage(listener: (message: GossipMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * 獲取連線 ID（返回 mesh userId）
   */
  getId(): string {
    return this.meshUserId;
  }

  /**
   * 獲取連線狀態
   */
  getState(): string {
    const connectionManager = this.p2pManager.getConnectionManager();
    return connectionManager.getState();
  }

  /**
   * 請求鄰居列表（用於節點發現）
   */
  async requestNeighborList(): Promise<string[]> {
    // 這裡可以實作一個協議來請求鄰居列表
    // 簡化版：返回空陣列
    return [];
  }

  /**
   * 關閉連線
   */
  async close(): Promise<void> {
    await this.p2pManager.close();
    this.messageListeners.clear();
  }
}
