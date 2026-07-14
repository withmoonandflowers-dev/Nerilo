import { IdentityManager } from './IdentityManager';
import { SecurityManager } from './SecurityManager';
import { MeshTopologyManager } from './MeshTopologyManager';
import { GossipMessageHandler } from './GossipMessageHandler';
import { RoomKeyCoordinator, rosterFromRoom } from './RoomKeyCoordinator';
import type { MeshConnection } from './MeshConnection';
import { HeartbeatService } from './HeartbeatService';
import { getGossipReplicaStore } from '../../services/GossipReplicaStore';
import type { IRoomDirectory } from '../../ports/IRoomDirectory';
import { RelayManager } from '../relay/RelayManager';
import { PeerScoring } from '../relay/PeerScoring';
import { logger } from '../../utils/logger';
import type { GossipMessage } from '../../types';
import type { SignalingFactory } from '../p2p/SignalingTransport';
import type { EncryptionState } from '../../types';

/**
 * Mesh Gossip 管理器
 * 整合所有 Mesh 相關功能的主管理器
 */
export class MeshGossipManager {
  private identityManager: IdentityManager;
  private securityManager: SecurityManager;
  private topologyManager: MeshTopologyManager | null = null;
  private messageHandler: GossipMessageHandler | null = null;
  private heartbeatService: HeartbeatService | null = null;
  private relayManager: RelayManager | null = null;
  private peerScoring: PeerScoring | null = null;
  private initialized = false;
  private neighborCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** 房間內容金鑰協調器（ADR-0023 P2-②c keyx）；產生方側編排 */
  private keyCoordinator: RoomKeyCoordinator | null = null;
  /** keyx 週期評估計時器（產生方偵測名冊變動並分發） */
  private keyxInterval: ReturnType<typeof setInterval> | null = null;
  /** keyx 評估週期：稍慢於鄰居掃描，且用快取讀名冊，省 Firestore server 讀 */
  private static readonly KEYX_TICK_MS = 4000;
  /**
   * 暫態信號（typing）監聽器。走 ns:'presence' lossy 通道，不進 gossip 日誌/對帳。
   * 對齊星型 ChatService.onTyping 的 {userId,isTyping} 契約，讓 UI 兩路可共用。
   */
  private typingListeners: Set<(data: { userId: string; isTyping: boolean }) => void> = new Set();

  constructor(
    private roomId: string,
    private localUid: string, // signaling/名冊身分 id（上層注入，取代 auth.currentUser）
    private signalingFactory?: SignalingFactory, // 省略＝Firestore；SDK 注入自架後端
    private directory?: IRoomDirectory // 省略＝initialize() 時動態載入 Firestore（本檔靜態圖無 firebase）
  ) {
    this.identityManager = new IdentityManager();
    this.securityManager = new SecurityManager();
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('[MeshGossipManager] Already initialized');
      return;
    }

    logger.info('[MeshGossipManager] Initializing', { roomId: this.roomId });

    try {
      // 1. 建立身分
      await this.identityManager.initialize();
      const userId = this.identityManager.getUserId();
      const pubKey = await this.identityManager.exportPublicKey();
      // ECDH 公鑰（keyx 成對封裝用，ADR-0023 P2-②c）；失敗不擋 mesh（退明文相容）
      let ecdhPubKey: string | undefined;
      try {
        ecdhPubKey = await this.identityManager.exportEcdhPublicKey();
      } catch (err) {
        logger.warn('[MeshGossipManager] ECDH pubkey unavailable — room stays plaintext', {
          roomId: this.roomId, err,
        });
      }

      // 2. 註冊身分到名冊（directory；未注入則此刻動態載入預設 Firestore adapter →
      //    本檔靜態圖無 firebase，SDK 可脫離 Firebase import）。
      const firebaseUid = this.localUid; // 由上層注入（取代 auth.currentUser，去 Firebase 耦合）
      if (!firebaseUid) {
        throw new Error('User not authenticated');
      }
      if (!this.directory) {
        const { FirestoreRoomDirectory } = await import('../../services/FirestoreRoomDirectory');
        this.directory = new FirestoreRoomDirectory(this.roomId, firebaseUid);
      }

      await this.directory.registerIdentity({ userId, pubKey, ecdhPubKey });
      logger.info('[MeshGossipManager] Identity registered', {
        roomId: this.roomId,
        firebaseUid,
        userId,
      });

      // 3. 初始化拓撲管理器
      this.topologyManager = new MeshTopologyManager(
        this.roomId,
        userId,
        firebaseUid,
        this.directory!, // 已於上方解析為非 undefined
        this.signalingFactory
      );

      // 4. 初始化 PeerScoring & RelayManager
      this.peerScoring = new PeerScoring();
      this.relayManager = new RelayManager({
        localNodeId: userId,
        roomId: this.roomId,
      });
      await this.relayManager.initialize();

      // 5. 初始化訊息處理器（注入 PeerScoring + 複本持久化，ADR-0023 P1）。
      // 持久層不可用（node 測試/Safari 隱私模式）時為 null → 記憶體模式。
      this.messageHandler = new GossipMessageHandler(
        this.roomId,
        userId,
        this.identityManager,
        this.securityManager,
        this.topologyManager,
        this.peerScoring,
        getGossipReplicaStore()
      );
      // 連線建立前先從複本重生（seq 水位、紀錄、floors）
      await this.messageHandler.hydrate();

      // keyx 消費啟用（ADR-0023 P2-②c）：注入本機 ECDH 私鑰，讓 handler 能開出封給
      // 自己的房間金鑰。ECDH 不可用（持久失敗且無 webcrypto）時退明文相容。
      if (ecdhPubKey) {
        try {
          this.messageHandler.setKeyxPrivateKey(this.identityManager.getEcdhPrivateKey());
          this.keyCoordinator = new RoomKeyCoordinator({
            localUserId: userId,
            getEcdhPrivateKey: () => this.identityManager.getEcdhPrivateKey(),
            getEcdhPublicKeyBase64: () => this.identityManager.exportEcdhPublicKey(),
            // 快取讀（forceServer=false）：keyx 週期輪詢不需每次強制 server 讀。
            // 名冊＝meshIdentities ∩ participants（離開者 meshIdentity 未即時清 →
            // 必須交集 participants，否則離開者續留名冊、續被封鑰 → 無前向保密，見 rosterFromRoom）。
            loadRoster: async () => {
              const snap = await this.directory!.getSnapshot(true); // preferCached：週期輪詢用快取即可
              return rosterFromRoom(snap.meshIdentities, snap.participants);
            },
            sendKeyx: (content) => this.messageHandler!.sendMessage(content, undefined, 'keyx'),
            applyLocalKey: (key, epoch) => this.messageHandler!.setContentKey(key, epoch),
            getMaxKnownEpoch: () => this.messageHandler!.getMaxKnownEpoch(),
          });
        } catch (err) {
          logger.warn('[MeshGossipManager] keyx coordinator init failed — plaintext room', {
            roomId: this.roomId, err,
          });
          this.keyCoordinator = null;
        }
      }

      // 5. 初始化心跳服務
      this.heartbeatService = new HeartbeatService(userId);
      this.heartbeatService.onUnreachable((peerId) => {
        logger.warn('[MeshGossipManager] Peer unreachable, triggering neighbor replacement', {
          roomId: this.roomId, peerId,
        });
        this.topologyManager?.handleNeighborDisconnected(peerId);
      });

      // 6. 初始化拓撲（建立鄰居連線）
      if (this.topologyManager) {
        await this.topologyManager.initialize();

        // 啟動心跳
        this.heartbeatService.start(() =>
          this.topologyManager
            ? this.topologyManager.getNeighbors().map(n => n.getId())
            : []
        );

        // 設置鄰居連線的訊息監聽（在連線建立後）
        this.setupNeighborMessageHandlers();

        // 啟動 keyx 週期評估（ADR-0023 P2-②c）：產生方偵測名冊變動 → 分發內容金鑰。
        // 非產生方為 no-op（純等 keyx 進來由 handler 消費）。與鄰居掃描解耦、獨立計時。
        this.startKeyxCoordination();
      }

      this.initialized = true;
      logger.info('[MeshGossipManager] Initialization completed', {
        roomId: this.roomId,
        userId,
        neighborCount: this.topologyManager?.getNeighborCount() || 0,
      });
    } catch (error) {
      logger.error('[MeshGossipManager] Initialization failed', {
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

    /** 已註冊到 RelayManager 的 peer 集合 */
    const registeredRelayPeers = new Set<string>();
    /**
     * 已接線（onMessage/onDigest）的連線實例。必須以「實例」為鍵：
     * - 以 peerId 為鍵會漏掉重連後的新實例（新連線沒有監聽器 → 收不到訊息）；
     * - 完全不記錄則每 2 秒重複註冊新 closure，同一則訊息被處理 N 次。
     */
    const wiredConnections = new WeakSet<MeshConnection>();

    // 每 2 秒掃描鄰居列表：為新連線接線，並對已連上鄰居做 anti-entropy 對帳
    this.neighborCheckInterval = setInterval(() => {
      if (!this.topologyManager || !this.messageHandler) return;

      const neighbors = this.topologyManager.getNeighbors();
      const currentIds = new Set<string>();

      neighbors.forEach(neighbor => {
        const peerId = neighbor.getId();
        currentIds.add(peerId);

        // 註冊新鄰居到 RelayManager
        if (this.relayManager && !registeredRelayPeers.has(peerId)) {
          this.relayManager.registerPeer(peerId);
          registeredRelayPeers.add(peerId);
        }

        if (!wiredConnections.has(neighbor)) {
          wiredConnections.add(neighbor);

          neighbor.onMessage(async (message: GossipMessage) => {
            // 處理 relay 封包
            const raw = message as unknown as Record<string, unknown>;
            if (raw.type === 'relay:forward') {
              await this.relayManager?.handleRelayPacket(peerId, JSON.stringify(raw));
              return;
            }

            if (this.messageHandler) {
              await this.messageHandler.handleReceivedMessage(message, peerId);
            }
          });

          // 對方的 digest 進來 → 比對本地 store，把對方缺的訊息補送過去
          neighbor.onDigest((digest) => {
            void this.messageHandler?.handleDigest(digest, neighbor);
          });

          // 暫態信號（typing）：lossy、不進 store/對帳。payload.userId = 送出者 mesh userId，
          // 只轉發給 typing 監聽器（UI 據此顯示「輸入中…」）。
          neighbor.onEphemeral((env) => {
            if (env.type !== 'TYPING') return;
            const p = env.payload as { userId?: unknown; isTyping?: unknown };
            if (typeof p?.userId !== 'string' || typeof p?.isTyping !== 'boolean') return;
            this.typingListeners.forEach((l) => {
              try {
                l({ userId: p.userId as string, isTyping: p.isTyping as boolean });
              } catch (err) {
                logger.error('[MeshGossipManager] typing listener error', { roomId: this.roomId, err });
              }
            });
          });
        }

        // 週期性 anti-entropy 對帳：送 digest 給已連上鄰居，對方回補我缺的訊息。
        // pull-based、冪等（收端以 (senderId, seq) 去重），不論連線成形時序、
        // 訊息何時送出、走哪條路徑，連通圖上數學上保證最終一致。
        if (neighbor.getState() === 'connected') {
          void this.messageHandler!.sendDigestTo(neighbor);
        }
      });

      // 取消註冊已離開的鄰居
      for (const peerId of registeredRelayPeers) {
        if (!currentIds.has(peerId)) {
          this.relayManager?.unregisterPeer(peerId);
          registeredRelayPeers.delete(peerId);
        }
      }
    }, 2000);
  }

  /**
   * 啟動 keyx 週期評估計時器。coordinator.tick() 內部冪等（穩定名冊只分發一次），
   * 非產生方為 no-op。任一 tick 失敗留待下輪重試，不影響 mesh 收送（無鑰退明文）。
   */
  private startKeyxCoordination(): void {
    if (!this.keyCoordinator) return; // ECDH 不可用 → 房間維持明文相容
    // 立即先跑一次（縮短形成期到密文化的空窗），再進週期
    void this.keyCoordinator.tick();
    this.keyxInterval = setInterval(() => {
      void this.keyCoordinator?.tick();
    }, MeshGossipManager.KEYX_TICK_MS);
  }

  /**
   * 發送訊息
   * @param messageId 應用層訊息 id，貫穿至 gossip payload（跨傳輸路徑去重）
   * @param channel 應用通道（M4）：缺省 'chat'；遊戲事件帶 'game'，
   *   走同一條「簽章+去重+anti-entropy 對帳」管線，獲得同等恰好一次保證
   */
  async sendMessage(
    content: string,
    messageId?: string,
    channel?: GossipMessage['channel'],
    timestamp?: number
  ): Promise<void> {
    if (!this.initialized || !this.messageHandler) {
      throw new Error('MeshGossipManager not initialized. Call initialize() first.');
    }
    return await this.messageHandler.sendMessage(content, messageId, channel, timestamp);
  }

  /**
   * 廣播 typing 暫態信號給所有已連上鄰居（lossy、best-effort）。
   * 不進 gossip 日誌/對帳——typing 遲送無意義。payload 帶自己的 mesh userId
   * 供收端過濾（雖 mesh 不回吐自送，2 人房收端天然只收到對方）。
   */
  async broadcastTyping(isTyping: boolean): Promise<void> {
    if (!this.initialized || !this.topologyManager) return;
    const me = this.getUserId();
    if (!me) return;
    const neighbors = this.topologyManager
      .getNeighbors()
      .filter((n) => n.getState() === 'connected');
    await Promise.all(
      neighbors.map((n) => n.sendEphemeral('TYPING', { userId: me, isTyping }))
    );
  }

  /** 監聽 peer 的 typing 信號（{userId,isTyping}，對齊星型 ChatService.onTyping） */
  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void {
    this.typingListeners.add(listener);
    return () => {
      this.typingListeners.delete(listener);
    };
  }

  /** 備援層加密（房間金鑰）；無金鑰回 null。見 GossipMessageHandler.encryptForFallback。 */
  async encryptForFallback(plaintext: string): Promise<string | null> {
    return this.messageHandler ? this.messageHandler.encryptForFallback(plaintext) : null;
  }

  /** 備援層解密（房間金鑰，按信封 epoch 選鑰）。 */
  async decryptForFallback(envelope: string): Promise<string> {
    if (!this.messageHandler) throw new Error('MeshGossipManager not initialized');
    return this.messageHandler.decryptForFallback(envelope);
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
   * 加密狀態（ADR-0026 R2 明文降級 fail-visible）：
   *  - 未初始化 → 'exchanging'（未知，不誤報明文）
   *  - keyCoordinator=null（ECDH 不可用）→ 'plaintext'（真降級，房間永久無法加密）
   *  - sendEpoch 就緒 → 'encrypted'；否則 keyx 進行中 → 'exchanging'
   */
  getEncryptionState(): EncryptionState {
    if (!this.initialized) return 'exchanging';
    if (!this.keyCoordinator) return 'plaintext';
    return this.messageHandler?.hasSendKey() ? 'encrypted' : 'exchanging';
  }

  /** 本機 mesh userId（hash pubKey）；未初始化時為 null。gossip senderId 用此。 */
  getUserId(): string | null {
    try {
      return this.identityManager.getUserId();
    } catch {
      return null;
    }
  }

  /**
   * 清理資源
   */
  async cleanup(): Promise<void> {
    if (this.neighborCheckInterval) {
      clearInterval(this.neighborCheckInterval);
      this.neighborCheckInterval = null;
    }
    if (this.keyxInterval) {
      clearInterval(this.keyxInterval);
      this.keyxInterval = null;
    }
    this.keyCoordinator = null;
    if (this.heartbeatService) {
      this.heartbeatService.stop();
      this.heartbeatService = null;
    }
    if (this.relayManager) {
      this.relayManager.shutdown();
      this.relayManager = null;
    }
    if (this.peerScoring) {
      this.peerScoring.destroy();
      this.peerScoring = null;
    }
    if (this.topologyManager) {
      await this.topologyManager.cleanup();
    }
    this.topologyManager = null;
    this.messageHandler = null;
    this.typingListeners.clear();
    this.initialized = false;
    logger.info('[MeshGossipManager] Cleaned up', { roomId: this.roomId });
  }

  /**
   * 取得 RelayManager 實例（供 ChatService 等外部模組使用）
   */
  getRelayManager(): RelayManager | null {
    return this.relayManager;
  }
}
