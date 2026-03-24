import type { GossipMessage } from '../../types';
import { getMessageId } from '../../utils/crypto';
import { IdentityManager } from './IdentityManager';
import { SecurityManager } from './SecurityManager';
import { MeshTopologyManager } from './MeshTopologyManager';
import type { MeshConnection } from './MeshConnection';

/**
 * Gossip 訊息處理器
 * 負責訊息的發送、接收、轉發和去重
 */
export class GossipMessageHandler {
  private seq = 0;
  private seenMessageIds: Set<string> = new Set();
  private lastSeenSeq: Map<string, number> = new Map();
  private sendRateLimiter: Map<string, number[]> = new Map();
  private messageListeners: Set<(message: GossipMessage) => void> = new Set();
  private readonly MAX_SEEN_SIZE = 10000;
  private readonly MAX_MESSAGES_PER_SECOND = 10;

  constructor(
    private roomId: string,
    private userId: string,
    private identityManager: IdentityManager,
    private securityManager: SecurityManager,
    private topologyManager: MeshTopologyManager
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
    
    // 建立訊息
    const message: Omit<GossipMessage, 'signature'> = {
      roomId: this.roomId,
      senderId: this.userId,
      pubKey: await this.identityManager.exportPublicKey(),
      seq: this.seq,
      timestamp: Date.now(),
      content,
      ttl: 8,
    };
    
    // 簽名
    const signature = await this.securityManager.signMessage(
      message,
      this.identityManager.getPrivateKey()
    );
    
    const signedMessage: GossipMessage = { ...message, signature };
    
    // 傳給隨機選的 2 個鄰居
    const neighbors = this.topologyManager.getNeighbors();
    const selected = this.selectRandomNeighbors(neighbors, 2);
    
    for (const neighbor of selected) {
      try {
        await neighbor.send(signedMessage);
      } catch (error) {
        console.warn('[GossipMessageHandler] Failed to send to neighbor', {
          roomId: this.roomId,
          neighborId: neighbor.getId(),
          error,
        });
      }
    }
    
    // 記錄已發送
    const messageId = await getMessageId(signedMessage);
    this.seenMessageIds.add(messageId);
    
    // 清理舊的訊息 ID
    this.cleanupSeenIds();
    
    // 通知本地監聽器
    this.notifyMessageListeners(signedMessage);
  }

  /**
   * 處理接收到的訊息
   */
  async handleReceivedMessage(
    message: GossipMessage,
    fromNeighbor: string
  ): Promise<void> {
    // 檢查是否已見過
    const messageId = await getMessageId(message);
    if (this.seenMessageIds.has(messageId)) {
      return; // 已處理過
    }
    
    // 驗證簽名
    const publicKey = await this.securityManager.importPublicKey(message.pubKey);
    const isValid = await this.securityManager.verifyMessage(message, publicKey);

    if (!isValid) {
      console.warn('[GossipMessageHandler] Invalid signature', {
        roomId: this.roomId,
        messageId,
        senderId: message.senderId,
      });
      return; // 簽名無效
    }

    // 驗證 pubKey 對應 senderId（#16：防止攻擊者用自己的 key 偽造其他人的 senderId）
    if (this.identityManager) {
      const derivedId = await this.identityManager.deriveUserId(publicKey);
      if (derivedId !== message.senderId) {
        console.warn('[GossipMessageHandler] Sender identity mismatch (possible spoofing)', {
          roomId: this.roomId,
          claimed: message.senderId,
          derived: derivedId,
        });
        return;
      }
    }

    // 檢查 TTL 型別驗證 (#39)
    if (typeof message.ttl !== 'number' || !Number.isFinite(message.ttl)) {
      console.warn('[GossipMessageHandler] Invalid TTL type', {
        roomId: this.roomId,
        senderId: message.senderId,
        ttl: message.ttl,
      });
      return;
    }

    // 檢查序列號
    if (!this.checkSequence(message.senderId, message.seq)) {
      console.warn('[GossipMessageHandler] Invalid sequence', {
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
    
    // 清理舊的訊息 ID
    this.cleanupSeenIds();
    
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
    const neighbors = this.topologyManager.getNeighbors()
      .filter(n => n.getId() !== excludeNeighbor);
    
    const selected = this.selectRandomNeighbors(neighbors, 2);
    
    for (const neighbor of selected) {
      try {
        await neighbor.send(message);
      } catch (error) {
        console.warn('[GossipMessageHandler] Failed to forward message', {
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
      console.warn('[GossipMessageHandler] Large sequence gap', {
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
   * 清理舊的訊息 ID
   */
  private cleanupSeenIds(): void {
    if (this.seenMessageIds.size > this.MAX_SEEN_SIZE) {
      // 簡單策略：清空一半
      const idsArray = Array.from(this.seenMessageIds);
      const toKeep = idsArray.slice(0, this.MAX_SEEN_SIZE / 2);
      this.seenMessageIds = new Set(toKeep);
    }
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
        console.error('[GossipMessageHandler] Error in message listener', {
          roomId: this.roomId,
          error,
        });
      }
    });
  }
}
