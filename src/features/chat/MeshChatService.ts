import { MeshGossipManager } from '../../core/mesh/MeshGossipManager';
import type { IChatStorage } from '../../ports';
import { indexedDBService } from '../../services/IndexedDBService';
import type { ChatMessage, GossipMessage } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Mesh Chat Service
 * 使用 Gossip 協議處理聊天訊息；支援注入 IChatStorage 以利測試與可插拔。
 */
export class MeshChatService {
  private meshGossipManager: MeshGossipManager;
  private chatStorage: IChatStorage;
  private messageListeners: Set<(message: ChatMessage) => void> = new Set();
  private messageCounter = 0;
  /** 本機的 mesh userId（hash pubKey）。gossip senderId 用此，非 firebase uid。 */
  private meshUserId: string | null = null;

  constructor(
    private roomId: string,
    private localUid: string,
    chatStorage: IChatStorage = indexedDBService
  ) {
    this.meshGossipManager = new MeshGossipManager(roomId);
    this.chatStorage = chatStorage;
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    await this.meshGossipManager.initialize();
    // gossip 的 senderId 是 mesh userId（hash pubKey），不是 firebase uid。
    // 取本機 mesh userId 以正確過濾「自己的訊息」（否則自訊息會重複顯示）。
    this.meshUserId = this.meshGossipManager.getUserId();

    // 監聽 Gossip 訊息
    this.meshGossipManager.onMessage((gossipMessage: GossipMessage) => {
      // 通道分流（M4）：gossip 管線同時載聊天與遊戲事件；非 chat 通道
      // （如 'game'，content 是遊戲 envelope JSON）不得進聊天顯示。
      if (gossipMessage.channel !== undefined && gossipMessage.channel !== 'chat') return;

      // 過濾自己的回音：anti-entropy / gossip 可能把本機訊息繞回；本機已樂觀顯示。
      // 必須比 mesh userId（senderId 的實際型別），比 firebase uid 永不命中。
      if (gossipMessage.senderId === this.meshUserId) return;

      // 轉換為 ChatMessage。id 優先用寄件端的應用層 id（簽章保護）：
      // 同一則訊息可能同時經 mesh 與 Firestore 備援到達，同 id 才能被 UI 去重。
      const chatMessage: ChatMessage = {
        messageId: gossipMessage.messageId ?? `${gossipMessage.senderId}-${gossipMessage.seq}`,
        from: gossipMessage.senderId,
        content: gossipMessage.content,
        timestamp: gossipMessage.timestamp,
      };

      this.chatStorage.saveChatMessage(chatMessage, this.roomId).catch(error => {
        logger.error('[MeshChatService] Failed to save message to IndexedDB', { error });
      });

      // 通知監聽器
      this.messageListeners.forEach(listener => {
        try {
          listener(chatMessage);
        } catch (error) {
          logger.error('[MeshChatService] Error in message listener', { error });
        }
      });
    });
  }

  /**
   * 發送訊息
   */
  async sendMessage(content: string, providedMessageId?: string): Promise<string> {
    // 呼叫端可傳入 id，讓樂觀顯示與本機自我 emit 共用同一 id（去重收斂）。
    // 未傳入時自生：自增 counter 避免同一毫秒內多則訊息 ID 碰撞。
    const messageId = providedMessageId ?? `${this.localUid}-${Date.now()}-${++this.messageCounter}`;

    // id 一併進 gossip payload：收端跨傳輸路徑（mesh / Firestore 備援）以同 id 去重
    await this.meshGossipManager.sendMessage(content, messageId);
    
    // 建立 ChatMessage（用於本地顯示）
    const chatMessage: ChatMessage = {
      messageId,
      from: this.localUid,
      content,
      timestamp: Date.now(),
    };

    await this.chatStorage.saveChatMessage(chatMessage, this.roomId);

    // 通知本地監聽器
    this.messageListeners.forEach(listener => listener(chatMessage));

    return messageId;
  }

  /**
   * 送 typing 暫態信號（lossy，走 mesh presence 通道，不進 gossip 日誌）。
   * best-effort：失敗吞掉，下次 keystroke 再送。對齊星型 ChatService.sendTyping。
   */
  async sendTyping(isTyping: boolean): Promise<void> {
    try {
      await this.meshGossipManager.broadcastTyping(isTyping);
    } catch {
      /* typing 是 best-effort */
    }
  }

  /** 監聽 peer 的 typing（{userId,isTyping}，對齊星型 ChatService.onTyping） */
  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void {
    return this.meshGossipManager.onTyping(listener);
  }

  /**
   * 載入歷史訊息
   */
  async loadHistory(): Promise<ChatMessage[]> {
    return await this.chatStorage.getChatMessages(this.roomId);
  }

  /**
   * 監聽訊息
   */
  onMessage(listener: (message: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * 獲取連線狀態
   */
  getConnectionState(): 'idle' | 'connecting' | 'connected' | 'failed' | 'closed' {
    if (!this.meshGossipManager.isInitialized()) {
      return 'idle';
    }
    
    const state = this.meshGossipManager.getConnectionState();
    
    // 如果有至少 1 個已連線的鄰居，視為已連線
    // 這樣可以確保即使部分連線失敗，整體仍可運作
    if (state.neighborCount > 0) {
      return 'connected';
    } else if (state.totalNeighbors > 0) {
      return 'connecting';
    } else {
      return 'idle';
    }
  }

  /**
   * mesh 覆蓋狀況：connected=已連上的鄰居數、known=已發現的鄰居數（含未連上）。
   * connected < known 代表有成員在 mesh 之外（多半掉到 Firestore 備援），
   * 呼叫端據此決定是否雙寫備援橋接。
   */
  getMeshCoverage(): { connected: number; known: number } {
    const s = this.meshGossipManager.getConnectionState();
    return { connected: s.neighborCount, known: s.totalNeighbors };
  }

  /**
   * 清理資源
   */
  async cleanup(): Promise<void> {
    await this.meshGossipManager.cleanup();
    this.messageListeners.clear();
  }
}
