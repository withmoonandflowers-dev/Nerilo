import type { ChatMessage } from '../../types';
import type { IChatStorage } from '../../ports/IChatStorage';

/**
 * 純記憶體訊息儲存（無 IndexedDB/Firebase），供 node/測試/自架環境注入。
 * 預設 IndexedDBService 需要瀏覽器 indexedDB；這顆讓 SDK 在無瀏覽器環境也能跑。
 */
export class InMemoryChatStorage implements IChatStorage {
  private byRoom = new Map<string, ChatMessage[]>();

  async saveChatMessage(message: ChatMessage, roomId: string): Promise<void> {
    const list = this.byRoom.get(roomId) ?? [];
    if (list.some((m) => m.messageId === message.messageId)) return; // 同 id 去重（跨傳輸路徑）
    list.push({ ...message });
    this.byRoom.set(roomId, list);
  }

  async getChatMessages(roomId: string, limit?: number): Promise<ChatMessage[]> {
    const list = this.byRoom.get(roomId) ?? [];
    const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
    return limit != null ? sorted.slice(-limit) : sorted;
  }

  async updateChatMessage(messageId: string, updates: Partial<ChatMessage>): Promise<void> {
    for (const list of this.byRoom.values()) {
      const m = list.find((x) => x.messageId === messageId);
      if (m) Object.assign(m, updates);
    }
  }

  async deleteChatMessage(messageId: string): Promise<void> {
    for (const [roomId, list] of this.byRoom.entries()) {
      this.byRoom.set(roomId, list.filter((m) => m.messageId !== messageId));
    }
  }
}
