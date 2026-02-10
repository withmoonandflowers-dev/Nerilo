import { MeshGossipManager } from '../../core/mesh/MeshGossipManager';
import { indexedDBService } from '../../services/IndexedDBService';
import type { ChatMessage, GossipMessage } from '../../types';

/**
 * Mesh Chat Service
 * 使用 Gossip 協議處理聊天訊息
 */
export class MeshChatService {
  private meshGossipManager: MeshGossipManager;
  private messageListeners: Set<(message: ChatMessage) => void> = new Set();

  constructor(
    private roomId: string,
    private localUid: string
  ) {
    this.meshGossipManager = new MeshGossipManager(roomId);
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    await this.meshGossipManager.initialize();

    // 監聽 Gossip 訊息
    this.meshGossipManager.onMessage((gossipMessage: GossipMessage) => {
      // 轉換為 ChatMessage
      const chatMessage: ChatMessage = {
        messageId: `${gossipMessage.senderId}-${gossipMessage.seq}`,
        from: gossipMessage.senderId,
        content: gossipMessage.content,
        timestamp: gossipMessage.timestamp,
      };

      // 儲存到 IndexedDB
      indexedDBService.saveChatMessage(chatMessage, this.roomId).catch(error => {
        console.error('[MeshChatService] Failed to save message to IndexedDB', { error });
      });

      // 通知監聽器
      this.messageListeners.forEach(listener => {
        try {
          listener(chatMessage);
        } catch (error) {
          console.error('[MeshChatService] Error in message listener', { error });
        }
      });
    });
  }

  /**
   * 發送訊息
   */
  async sendMessage(content: string): Promise<string> {
    await this.meshGossipManager.sendMessage(content);

    // 生成 messageId（簡化版，實際應該從 Gossip 訊息獲取）
    // 注意：這裡無法直接訪問 identityManager，所以使用時間戳
    const messageId = `${this.localUid}-${Date.now()}`;
    
    // 建立 ChatMessage（用於本地顯示）
    const chatMessage: ChatMessage = {
      messageId,
      from: this.localUid,
      content,
      timestamp: Date.now(),
    };

    // 儲存到 IndexedDB
    await indexedDBService.saveChatMessage(chatMessage, this.roomId);

    // 通知本地監聽器
    this.messageListeners.forEach(listener => listener(chatMessage));

    return messageId;
  }

  /**
   * 載入歷史訊息
   */
  async loadHistory(): Promise<ChatMessage[]> {
    return await indexedDBService.getChatMessages(this.roomId);
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
   * 清理資源
   */
  async cleanup(): Promise<void> {
    await this.meshGossipManager.cleanup();
    this.messageListeners.clear();
  }
}
