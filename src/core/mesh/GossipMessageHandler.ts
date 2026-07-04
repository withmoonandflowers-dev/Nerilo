import type { GossipMessage } from '../../types';
import { getMessageId } from '../../utils/crypto';
import { IdentityManager } from './IdentityManager';
import { SecurityManager } from './SecurityManager';
import { MeshTopologyManager } from './MeshTopologyManager';
import type { MeshConnection } from './MeshConnection';
import { TimeBucketedCache } from './TimeBucketedCache';
import type { PeerScoring } from '../relay/PeerScoring';
import { logger } from '../../utils/logger';

/**
 * Gossip 訊息處理器
 * 負責訊息的發送、接收、轉發和去重
 */
export class GossipMessageHandler {
  private seq = 0;
  /** Time-bucketed 去重快取（取代無上限的 Set，避免記憶體洩漏） */
  private seenMessageIds = new TimeBucketedCache(60_000, 10);
  private lastSeenSeq: Map<string, number> = new Map();
  private sendRateLimiter: Map<string, number[]> = new Map();
  private messageListeners: Set<(message: GossipMessage) => void> = new Set();
  private readonly MAX_MESSAGES_PER_SECOND = 10;
  /**
   * 最近訊息緩衝（anti-entropy）：全 mesh 廣播是 ttl=1 直送，假設送出時 mesh 已全連上。
   * 但連線非同步成形，早送的訊息對「尚未連上的人」會永久遺失。保留最近 60s 訊息，
   * 新鄰居一連上就補送（syncToNeighbor），收端以 seenMessageIds 去重，達成最終一致。
   */
  private recentMessages: { msg: GossipMessage; at: number }[] = [];
  private readonly RECENT_TTL_MS = 60_000;

  constructor(
    private roomId: string,
    private userId: string,
    private identityManager: IdentityManager,
    private securityManager: SecurityManager,
    private topologyManager: MeshTopologyManager,
    private peerScoring: PeerScoring | null = null
  ) {}

  /**
   * 發送訊息
   */
  async sendMessage(content: string): Promise<void> {
    // Rate limiting
    if (!this.checkSendRate(this.userId)) {
      throw new Error('Rate limit exceeded');
    }
    
    // seq += 1
    this.seq++;
    
    // 從拓撲管理器讀取動態 gossip 設定
    const gossipConfig = this.topologyManager.getGossipConfig();

    // 建立訊息
    const message: Omit<GossipMessage, 'signature'> = {
      roomId: this.roomId,
      senderId: this.userId,
      pubKey: await this.identityManager.exportPublicKey(),
      seq: this.seq,
      timestamp: Date.now(),
      content,
      ttl: gossipConfig.ttl,
    };

    // 簽名
    const signature = await this.securityManager.signMessage(
      message,
      this.identityManager.getPrivateKey()
    );

    const signedMessage: GossipMessage = { ...message, signature };

    // 傳給隨機選的鄰居（fanout 由 AdaptiveTopologyManager 決定）
    const neighbors = this.topologyManager.getNeighbors();
    const selected = this.selectRandomNeighbors(neighbors, gossipConfig.fanout);
    
    for (const neighbor of selected) {
      try {
        await neighbor.send(signedMessage);
      } catch (error) {
        logger.warn('[GossipMessageHandler] Failed to send to neighbor', {
          roomId: this.roomId,
          neighborId: neighbor.getId(),
          error,
        });
      }
    }
    
    // 記錄已發送（去重 + anti-entropy 緩衝）
    const messageId = await getMessageId(signedMessage);
    this.seenMessageIds.add(messageId);
    this.recordRecent(signedMessage);

    // 註：送出時「不」回吐給本地監聽器。自己訊息的顯示由應用層負責
    // （MeshChatService 樂觀更新，id 與 ChatPage 一致）。gossip 層在此回吐會用
    // 另一套 id（userId-seq）造成自訊息重複。收訊路徑仍照常 notify。
  }

  /**
   * 處理接收到的訊息
   */
  async handleReceivedMessage(
    message: GossipMessage,
    fromNeighbor: string
  ): Promise<void> {
    // 灰名單檢查：跳過低信譽 peer 的訊息
    if (this.peerScoring?.isGraylisted(fromNeighbor)) {
      return;
    }

    // 檢查是否已見過
    const messageId = await getMessageId(message);
    if (this.seenMessageIds.has(messageId)) {
      this.peerScoring?.recordDuplicate(fromNeighbor);
      return; // 已處理過
    }

    // 驗證簽名
    const publicKey = await this.securityManager.importPublicKey(message.pubKey);
    const isValid = await this.securityManager.verifyMessage(message, publicKey);

    if (!isValid) {
      logger.warn('[GossipMessageHandler] Invalid signature', {
        roomId: this.roomId,
        messageId,
        senderId: message.senderId,
      });
      this.peerScoring?.recordInvalidMessage(fromNeighbor);
      return; // 簽名無效
    }

    // 驗證 pubKey 對應 senderId（#16：防止攻擊者用自己的 key 偽造其他人的 senderId）
    if (this.identityManager) {
      const derivedId = await this.identityManager.deriveUserId(publicKey);
      if (derivedId !== message.senderId) {
        logger.warn('[GossipMessageHandler] Sender identity mismatch (possible spoofing)', {
          roomId: this.roomId,
          claimed: message.senderId,
          derived: derivedId,
        });
        this.peerScoring?.recordInvalidMessage(fromNeighbor);
        return;
      }
    }

    // 檢查 TTL 型別驗證 (#39)
    if (typeof message.ttl !== 'number' || !Number.isFinite(message.ttl)) {
      logger.warn('[GossipMessageHandler] Invalid TTL type', {
        roomId: this.roomId,
        senderId: message.senderId,
        ttl: message.ttl,
      });
      return;
    }

    // 檢查序列號
    if (!this.checkSequence(message.senderId, message.seq)) {
      logger.warn('[GossipMessageHandler] Invalid sequence', {
        roomId: this.roomId,
        messageId,
        senderId: message.senderId,
        seq: message.seq,
      });
      return; // 序列號無效
    }
    
    // 檢查 TTL
    if (message.ttl <= 0) {
      return; // TTL 已耗盡
    }
    
    // 記錄已見過
    this.seenMessageIds.add(messageId);
    this.recordRecent(message);

    // 記錄有效訊息投遞（提升 peer 信譽）
    this.peerScoring?.recordDelivery(fromNeighbor);

    // 顯示訊息
    this.notifyMessageListeners(message);

    // 轉發（建立副本以避免修改傳入物件）
    const forwarded: GossipMessage = { ...message, ttl: message.ttl - 1 };
    await this.forwardMessage(forwarded, fromNeighbor);
  }

  /**
   * 轉發訊息
   */
  private async forwardMessage(
    message: GossipMessage,
    excludeNeighbor: string
  ): Promise<void> {
    const gossipConfig = this.topologyManager.getGossipConfig();
    const neighbors = this.topologyManager.getNeighbors()
      .filter(n => n.getId() !== excludeNeighbor);

    const selected = this.selectRandomNeighbors(neighbors, gossipConfig.fanout);
    
    for (const neighbor of selected) {
      try {
        await neighbor.send(message);
      } catch (error) {
        logger.warn('[GossipMessageHandler] Failed to forward message', {
          roomId: this.roomId,
          neighborId: neighbor.getId(),
          error,
        });
      }
    }
  }

  /**
   * 檢查序列號
   */
  private checkSequence(senderId: string, seq: number): boolean {
    const lastSeq = this.lastSeenSeq.get(senderId) || 0;
    
    // 允許一定的序列號間隙（處理網路延遲）
    const MAX_SEQ_GAP = 100;
    
    if (seq <= lastSeq) {
      return false; // 舊訊息或重放
    }
    
    if (seq > lastSeq + MAX_SEQ_GAP) {
      // 序列號跳躍太大，可能是攻擊
      logger.warn('[GossipMessageHandler] Large sequence gap', {
        roomId: this.roomId,
        senderId,
        lastSeq,
        seq,
      });
      // 選擇接受，但記錄警告
    }
    
    this.lastSeenSeq.set(senderId, seq);
    return true;
  }

  /**
   * 檢查發送速率
   */
  private checkSendRate(senderId: string): boolean {
    const now = Date.now();
    const timestamps = this.sendRateLimiter.get(senderId) || [];
    const recent = timestamps.filter(ts => now - ts < 1000);
    
    if (recent.length >= this.MAX_MESSAGES_PER_SECOND) {
      return false; // 超過速率限制
    }
    
    recent.push(now);
    this.sendRateLimiter.set(senderId, recent);
    return true;
  }

  /**
   * 隨機選擇鄰居
   */
  private selectRandomNeighbors(
    neighbors: MeshConnection[],
    count: number
  ): MeshConnection[] {
    const shuffled = [...neighbors].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, neighbors.length));
  }

  /** 記錄一則最近訊息（供 anti-entropy 補送），並清掉過期的 */
  private recordRecent(msg: GossipMessage): void {
    this.recentMessages.push({ msg, at: Date.now() });
    this.pruneRecent();
  }

  private pruneRecent(): void {
    const cutoff = Date.now() - this.RECENT_TTL_MS;
    if (this.recentMessages.length > 0 && this.recentMessages[0]!.at < cutoff) {
      this.recentMessages = this.recentMessages.filter((r) => r.at >= cutoff);
    }
  }

  /**
   * anti-entropy：把最近訊息補送給「剛連上的」鄰居。
   * 收端以 seenMessageIds 去重，已看過的自動略過。解決「訊息在對方連上前送出」的遺失。
   */
  async syncToNeighbor(neighbor: MeshConnection): Promise<void> {
    this.pruneRecent();
    for (const { msg } of this.recentMessages) {
      try {
        await neighbor.send(msg);
      } catch (error) {
        logger.warn('[GossipMessageHandler] anti-entropy sync failed', {
          roomId: this.roomId,
          neighborId: neighbor.getId(),
          error,
        });
      }
    }
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
   * 通知監聽器
   */
  private notifyMessageListeners(message: GossipMessage): void {
    this.messageListeners.forEach(listener => {
      try {
        listener(message);
      } catch (error) {
        logger.error('[GossipMessageHandler] Error in message listener', {
          roomId: this.roomId,
          error,
        });
      }
    });
  }
}
