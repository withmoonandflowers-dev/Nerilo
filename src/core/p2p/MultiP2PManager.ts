import { P2PManager } from './P2PManager';
import { P2PChannelBus } from './P2PChannelBus';
import type { ChatMessage } from '../../types';
import { generateUUID } from '../../utils/uuid';

/**
 * 多人 P2P 連線管理器
 * 使用星型拓撲：房主作為中心節點，其他用戶都與房主建立連線
 */
export class MultiP2PManager {
  private roomId: string;
  private localUid: string;
  private isHost: boolean;
  private connections: Map<string, P2PManager> = new Map(); // remoteUid -> P2PManager
  private messageListeners: Set<(message: ChatMessage) => void> = new Set();
  private connectionStateListeners: Map<string, Set<(state: string) => void>> = new Map();
  private messageQueue: Map<string, ChatMessage[]> = new Map(); // remoteUid -> messages

  constructor(roomId: string, localUid: string, isHost: boolean) {
    this.roomId = roomId;
    this.localUid = localUid;
    this.isHost = isHost;
  }

  /**
   * 添加與新用戶的連線
   */
  async addConnection(remoteUid: string): Promise<void> {
    if (this.connections.has(remoteUid)) {
      console.log('[MultiP2PManager] Connection already exists', {
        roomId: this.roomId,
        remoteUid,
      });
      return;
    }

    console.log('[MultiP2PManager] Adding connection', {
      roomId: this.roomId,
      localUid: this.localUid,
      remoteUid,
      isHost: this.isHost,
    });

    try {
      // 建立 P2P 連線
      // 房主作為 initiator，其他用戶作為 non-initiator
      const isInitiator = this.isHost;
      const p2pManager = new P2PManager(
        this.roomId,
        this.localUid,
        `chat-${remoteUid}`, // 每個連線使用獨立的 channel label
        isInitiator
      );

      await p2pManager.initialize();
      this.connections.set(remoteUid, p2pManager);

      // 監聽連線狀態
      const connectionManager = p2pManager.getConnectionManager();
      connectionManager.onStateChange((state) => {
        this.notifyConnectionState(remoteUid, state);
      });

      // 監聽訊息
      const channelBus = p2pManager.getChannelBus();
      if (channelBus) {
        this.setupMessageHandlers(remoteUid, channelBus);
      } else {
        // 如果 channelBus 還沒準備好，等待它準備好
        const checkInterval = setInterval(() => {
          const bus = p2pManager.getChannelBus();
          if (bus && bus.getReadyState() === 'open') {
            clearInterval(checkInterval);
            this.setupMessageHandlers(remoteUid, bus);
            // 發送佇列中的訊息
            this.flushMessageQueue(remoteUid);
          }
        }, 100);

        setTimeout(() => clearInterval(checkInterval), 10000);
      }

      console.log('[MultiP2PManager] Connection added successfully', {
        roomId: this.roomId,
        remoteUid,
        totalConnections: this.connections.size,
      });
    } catch (error) {
      console.error('[MultiP2PManager] Failed to add connection', {
        roomId: this.roomId,
        remoteUid,
        error,
      });
      throw error;
    }
  }

  /**
   * 移除連線
   */
  async removeConnection(remoteUid: string): Promise<void> {
    const p2pManager = this.connections.get(remoteUid);
    if (!p2pManager) {
      console.log('[MultiP2PManager] Connection not found', {
        roomId: this.roomId,
        remoteUid,
      });
      return;
    }

    console.log('[MultiP2PManager] Removing connection', {
      roomId: this.roomId,
      remoteUid,
    });

    try {
      // 清理連線
      await p2pManager.close();
      
      this.connections.delete(remoteUid);
      this.messageQueue.delete(remoteUid);
      this.connectionStateListeners.delete(remoteUid);

      console.log('[MultiP2PManager] Connection removed', {
        roomId: this.roomId,
        remoteUid,
        remainingConnections: this.connections.size,
      });
    } catch (error) {
      console.error('[MultiP2PManager] Error removing connection', {
        roomId: this.roomId,
        remoteUid,
        error,
      });
    }
  }

  /**
   * 發送訊息
   */
  async sendMessage(message: ChatMessage): Promise<void> {
    if (this.isHost) {
      // 房主：廣播給所有連線的用戶
      await this.broadcastMessage(message);
    } else {
      // 非房主：只發送給房主
      const hostConnection = this.connections.values().next().value;
      if (hostConnection) {
        await this.sendMessageToConnection(hostConnection, message);
      } else {
        console.warn('[MultiP2PManager] No host connection available', {
          roomId: this.roomId,
        });
        throw new Error('No connection to host');
      }
    }
  }

  /**
   * 廣播訊息（房主專用）
   */
  private async broadcastMessage(message: ChatMessage): Promise<void> {
    console.log('[MultiP2PManager] Broadcasting message', {
      roomId: this.roomId,
      messageId: message.messageId,
      targetCount: this.connections.size,
    });

    const promises = Array.from(this.connections.entries()).map(
      async ([remoteUid, p2pManager]) => {
        try {
          await this.sendMessageToConnection(p2pManager, message);
        } catch (error) {
          console.error('[MultiP2PManager] Failed to send message to connection', {
            roomId: this.roomId,
            remoteUid,
            messageId: message.messageId,
            error,
          });
        }
      }
    );

    await Promise.allSettled(promises);
  }

  /**
   * 轉發訊息（房主專用，轉發給除了發送者外的所有用戶）
   */
  async forwardMessage(fromUid: string, message: ChatMessage): Promise<void> {
    if (!this.isHost) {
      console.warn('[MultiP2PManager] Only host can forward messages', {
        roomId: this.roomId,
      });
      return;
    }

    console.log('[MultiP2PManager] Forwarding message', {
      roomId: this.roomId,
      fromUid,
      messageId: message.messageId,
      targetCount: this.connections.size - 1,
    });

    const promises = Array.from(this.connections.entries())
      .filter(([remoteUid]) => remoteUid !== fromUid)
      .map(async ([remoteUid, p2pManager]) => {
        try {
          await this.sendMessageToConnection(p2pManager, message);
        } catch (error) {
          console.error('[MultiP2PManager] Failed to forward message', {
            roomId: this.roomId,
            remoteUid,
            messageId: message.messageId,
            error,
          });
        }
      });

    await Promise.allSettled(promises);
  }

  /**
   * 發送訊息到特定連線
   */
  private async sendMessageToConnection(
    p2pManager: P2PManager,
    message: ChatMessage
  ): Promise<void> {
    const channelBus = p2pManager.getChannelBus();
    if (!channelBus || channelBus.getReadyState() !== 'open') {
      console.warn('[MultiP2PManager] ChannelBus not ready, queuing message', {
        roomId: this.roomId,
        messageId: message.messageId,
        readyState: channelBus?.getReadyState() || 'null',
      });
      // 將訊息加入佇列
      const remoteUid = this.getRemoteUidForConnection(p2pManager);
      if (remoteUid) {
        if (!this.messageQueue.has(remoteUid)) {
          this.messageQueue.set(remoteUid, []);
        }
        this.messageQueue.get(remoteUid)!.push(message);
      }
      return;
    }

    // 使用 ChatService 的格式發送訊息
    const envelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_SEND',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${p2pManager.getDeviceId()}`,
      payload: message,
    };

    await channelBus.send(envelope);
  }

  /**
   * 設置訊息處理器
   */
  private setupMessageHandlers(remoteUid: string, channelBus: P2PChannelBus): void {
    channelBus.subscribe('chat', async (envelope) => {
      if (envelope.type !== 'MSG_SEND') return;
      
      const message = envelope.payload as ChatMessage;
      
      console.log('[MultiP2PManager] Message received', {
        roomId: this.roomId,
        from: remoteUid,
        messageId: message.messageId,
        isHost: this.isHost,
      });

      if (this.isHost) {
        // 房主：轉發給其他用戶
        await this.forwardMessage(remoteUid, message);
      }

      // 通知所有監聽器
      this.messageListeners.forEach((listener) => {
        try {
          listener(message);
        } catch (error) {
          console.error('[MultiP2PManager] Error in message listener', {
            roomId: this.roomId,
            error,
          });
        }
      });
    });
  }

  /**
   * 發送佇列中的訊息
   */
  private flushMessageQueue(remoteUid: string): void {
    const p2pManager = this.connections.get(remoteUid);
    if (!p2pManager) return;
    
    const channelBus = p2pManager.getChannelBus();
    if (!channelBus) return;
    const queue = this.messageQueue.get(remoteUid);
    if (!queue || queue.length === 0) return;

    console.log('[MultiP2PManager] Flushing message queue', {
      roomId: this.roomId,
      remoteUid,
      queueLength: queue.length,
    });

    queue.forEach((message) => {
      this.sendMessageToConnection(
        this.connections.get(remoteUid)!,
        message
      ).catch((error) => {
        console.error('[MultiP2PManager] Failed to send queued message', {
          roomId: this.roomId,
          remoteUid,
          messageId: message.messageId,
          error,
        });
      });
    });

    this.messageQueue.delete(remoteUid);
  }

  /**
   * 獲取連線對應的 remoteUid
   */
  private getRemoteUidForConnection(p2pManager: P2PManager): string | null {
    for (const [remoteUid, manager] of this.connections.entries()) {
      if (manager === p2pManager) {
        return remoteUid;
      }
    }
    return null;
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
   * 監聽連線狀態
   */
  onConnectionState(remoteUid: string, listener: (state: string) => void): () => void {
    if (!this.connectionStateListeners.has(remoteUid)) {
      this.connectionStateListeners.set(remoteUid, new Set());
    }
    this.connectionStateListeners.get(remoteUid)!.add(listener);
    return () => {
      this.connectionStateListeners.get(remoteUid)?.delete(listener);
    };
  }

  /**
   * 通知連線狀態變化
   */
  private notifyConnectionState(remoteUid: string, state: string): void {
    const listeners = this.connectionStateListeners.get(remoteUid);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(state);
        } catch (error) {
          console.error('[MultiP2PManager] Error in connection state listener', {
            roomId: this.roomId,
            remoteUid,
            error,
          });
        }
      });
    }
  }

  /**
   * 獲取所有連線的狀態
   */
  getConnectionStates(): Map<string, string> {
    const states = new Map<string, string>();
    this.connections.forEach((p2pManager, remoteUid) => {
      const connectionManager = p2pManager.getConnectionManager();
      states.set(remoteUid, connectionManager.getState());
    });
    return states;
  }

  /**
   * 獲取連線數量
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * 清理所有連線
   */
  async disconnect(): Promise<void> {
    console.log('[MultiP2PManager] Disconnecting all connections', {
      roomId: this.roomId,
      connectionCount: this.connections.size,
    });

    const promises = Array.from(this.connections.keys()).map((remoteUid) =>
      this.removeConnection(remoteUid)
    );

    await Promise.allSettled(promises);
    this.connections.clear();
    this.messageQueue.clear();
    this.messageListeners.clear();
    this.connectionStateListeners.clear();
  }
}
