import type { P2PEnvelope, ChatMessage } from '../../types';
import { P2PChannelBus } from '../../core/p2p/P2PChannelBus';
import { generateUUID } from '../../utils/uuid';
import type { IChatStorage } from '../../ports';
import { indexedDBService } from '../../services/IndexedDBService';

export class ChatService {
  private channelBus: P2PChannelBus;
  private localUid: string;
  private deviceId: string;
  private roomId: string;
  private chatStorage: IChatStorage;
  private messageListeners: Set<(message: ChatMessage) => void> = new Set();

  constructor(
    channelBus: P2PChannelBus,
    localUid: string,
    deviceId: string,
    roomId: string,
    chatStorage: IChatStorage = indexedDBService
  ) {
    this.channelBus = channelBus;
    this.localUid = localUid;
    this.deviceId = deviceId;
    this.roomId = roomId;
    this.chatStorage = chatStorage;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    console.log('[ChatService] setupHandlers called', { roomId: this.roomId });
    this.channelBus.subscribe('chat', async (envelope) => {
      console.log('[ChatService] Received chat envelope', {
        roomId: this.roomId,
        envelopeId: envelope.id,
        type: envelope.type,
        from: envelope.from,
      });
      await this.handleChatMessage(envelope);
    });
    console.log('[ChatService] Handlers setup completed', { roomId: this.roomId });
  }

  async sendMessage(content: string, to?: string): Promise<string> {
    const messageId = generateUUID();
    const message: ChatMessage = {
      messageId,
      from: `${this.localUid}/${this.deviceId}`,
      to,
      content,
      timestamp: Date.now(),
    };

    console.log('[ChatService] sendMessage called', {
      roomId: this.roomId,
      messageId,
      from: this.localUid,
      to,
      contentLength: content.length,
    });

    await this.chatStorage.saveChatMessage(message, this.roomId);
    console.log('[ChatService] Message saved to IndexedDB', { roomId: this.roomId, messageId });

    // 發送 P2P 訊息
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_SEND',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      to,
      payload: message,
    };

    console.log('[ChatService] Sending P2P envelope', {
      roomId: this.roomId,
      envelopeId: envelope.id,
      channelBusReady: this.channelBus.getReadyState(),
    });

    await this.channelBus.send(envelope);
    console.log('[ChatService] P2P envelope sent', { roomId: this.roomId, envelopeId: envelope.id });

    // 通知本機監聽器
    this.messageListeners.forEach((listener) => listener(message));
    console.log('[ChatService] Local listeners notified', {
      roomId: this.roomId,
      listenerCount: this.messageListeners.size,
    });

    return messageId;
  }

  async editMessage(messageId: string, newContent: string): Promise<void> {
    // 更新 IndexedDB
    await this.chatStorage.updateChatMessage(messageId, {
      content: newContent,
      edited: true,
    });

    // 發送編輯訊息
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_EDIT',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: {
        messageId,
        content: newContent,
      },
    };

    await this.channelBus.send(envelope);
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.chatStorage.updateChatMessage(messageId, {
      deleted: true,
    });

    // 發送刪除訊息
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_DELETE',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: { messageId },
    };

    await this.channelBus.send(envelope);
  }

  async sendTyping(isTyping: boolean): Promise<void> {
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'TYPING',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: { isTyping },
    };

    await this.channelBus.send(envelope);
  }

  async loadHistory(limit = 100): Promise<ChatMessage[]> {
    return await this.chatStorage.getChatMessages(this.roomId, limit);
  }

  onMessage(listener: (message: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  private async handleChatMessage(envelope: P2PEnvelope): Promise<void> {
    console.log('[ChatService] handleChatMessage', {
      roomId: this.roomId,
      envelopeType: envelope.type,
      envelopeId: envelope.id,
      from: envelope.from,
    });

    switch (envelope.type) {
      case 'MSG_SEND':
        console.log('[ChatService] Handling MSG_SEND', {
          roomId: this.roomId,
          messageId: (envelope.payload as ChatMessage)?.messageId,
        });
        await this.handleMessageSend(envelope.payload as ChatMessage);
        break;
      case 'MSG_EDIT':
        await this.handleMessageEdit(envelope.payload as { messageId: string; content: string });
        break;
      case 'MSG_DELETE':
        await this.handleMessageDelete(envelope.payload as { messageId: string });
        break;
      case 'TYPING':
        // 處理輸入中狀態（可選）
        break;
    }
  }

  private async handleMessageSend(message: ChatMessage): Promise<void> {
    console.log('[ChatService] handleMessageSend', {
      roomId: this.roomId,
      messageId: message.messageId,
      from: message.from,
      contentLength: message.content.length,
    });

    await this.chatStorage.saveChatMessage(message, this.roomId);
    console.log('[ChatService] Message saved to IndexedDB in handleMessageSend', {
      roomId: this.roomId,
      messageId: message.messageId,
    });

    // 通知監聽器
    console.log('[ChatService] Notifying message listeners', {
      roomId: this.roomId,
      listenerCount: this.messageListeners.size,
      messageId: message.messageId,
    });
    this.messageListeners.forEach((listener) => listener(message));
    console.log('[ChatService] Message listeners notified', {
      roomId: this.roomId,
      messageId: message.messageId,
    });
  }

  private async handleMessageEdit(payload: { messageId: string; content: string }): Promise<void> {
    await this.chatStorage.updateChatMessage(payload.messageId, {
      content: payload.content,
      edited: true,
    });

    // 通知監聽器（可選：發送更新事件）
  }

  private async handleMessageDelete(payload: { messageId: string }): Promise<void> {
    await this.chatStorage.updateChatMessage(payload.messageId, {
      deleted: true,
    });
  }
}



