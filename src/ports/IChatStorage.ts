/**
 * 聊天儲存 Port（介面）
 * 實作可由 IndexedDB、Memory、Mock 等提供，利於解耦與測試。
 */
import type { ChatMessage } from '../types';

export interface IChatStorage {
  saveChatMessage(message: ChatMessage, roomId: string): Promise<void>;
  getChatMessages(roomId: string, limit?: number): Promise<ChatMessage[]>;
  updateChatMessage(messageId: string, updates: Partial<ChatMessage>): Promise<void>;
  deleteChatMessage(messageId: string): Promise<void>;
}
