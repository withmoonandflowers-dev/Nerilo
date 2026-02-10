import Dexie, { Table } from 'dexie';
import type { ChatMessage, FileMetadata } from '../types';

interface ChatRecord {
  id?: number;
  messageId: string;
  from: string;
  to?: string;
  content: string;
  timestamp: number;
  edited?: boolean;
  deleted?: boolean;
  roomId: string;
}

interface FileRecord {
  id?: number;
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  timestamp: number;
  roomId: string;
  blob?: Blob;
}

interface SystemEvent {
  id?: number;
  eventId: string;
  type: string;
  data: any;
  timestamp: number;
  roomId: string;
}

class NeriloDB extends Dexie {
  chats!: Table<ChatRecord>;
  files!: Table<FileRecord>;
  events!: Table<SystemEvent>;

  constructor() {
    super('NeriloDB');
    this.version(1).stores({
      chats: '++id, messageId, timestamp, roomId, from',
      files: '++id, fileId, timestamp, roomId',
      events: '++id, eventId, timestamp, roomId, type',
    });
  }
}

export class IndexedDBService {
  private db: NeriloDB;

  constructor() {
    this.db = new NeriloDB();
  }

  // 聊天紀錄
  async saveChatMessage(message: ChatMessage, roomId: string): Promise<void> {
    await this.db.chats.add({
      messageId: message.messageId,
      from: message.from,
      to: message.to,
      content: message.content,
      timestamp: message.timestamp,
      edited: message.edited,
      deleted: message.deleted,
      roomId,
    });
  }

  async getChatMessages(roomId: string, limit = 100): Promise<ChatMessage[]> {
    const records = await this.db.chats
      .where('roomId')
      .equals(roomId)
      .reverse()
      .limit(limit)
      .toArray();

    return records.map((r) => ({
      messageId: r.messageId,
      from: r.from,
      to: r.to,
      content: r.content,
      timestamp: r.timestamp,
      edited: r.edited,
      deleted: r.deleted,
    }));
  }

  async updateChatMessage(messageId: string, updates: Partial<ChatMessage>): Promise<void> {
    const record = await this.db.chats.where('messageId').equals(messageId).first();
    if (record) {
      await this.db.chats.update(record.id!, {
        ...updates,
      });
    }
  }

  async deleteChatMessage(messageId: string): Promise<void> {
    await this.db.chats.where('messageId').equals(messageId).delete();
  }

  // 檔案 metadata
  async saveFileMetadata(metadata: FileMetadata, roomId: string, blob?: Blob): Promise<void> {
    await this.db.files.add({
      fileId: metadata.fileId,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      fileType: metadata.fileType,
      timestamp: Date.now(),
      roomId,
      blob,
    });
  }

  async getFileMetadata(fileId: string): Promise<FileRecord | undefined> {
    return await this.db.files.where('fileId').equals(fileId).first();
  }

  async getFilesByRoom(roomId: string): Promise<FileRecord[]> {
    return await this.db.files.where('roomId').equals(roomId).toArray();
  }

  // 系統事件
  async saveSystemEvent(
    eventId: string,
    type: string,
    data: any,
    roomId: string
  ): Promise<void> {
    await this.db.events.add({
      eventId,
      type,
      data,
      timestamp: Date.now(),
      roomId,
    });
  }

  async getSystemEvents(roomId: string, type?: string): Promise<SystemEvent[]> {
    let query = this.db.events.where('roomId').equals(roomId);
    if (type) {
      query = query.filter((e) => e.type === type);
    }
    return await query.reverse().toArray();
  }

  // 清除資料
  async clearRoomData(roomId: string): Promise<void> {
    await Promise.all([
      this.db.chats.where('roomId').equals(roomId).delete(),
      this.db.files.where('roomId').equals(roomId).delete(),
      this.db.events.where('roomId').equals(roomId).delete(),
  ]);
  }

  async clearAllData(): Promise<void> {
    await Promise.all([
      this.db.chats.clear(),
      this.db.files.clear(),
      this.db.events.clear(),
    ]);
  }
}

export const indexedDBService = new IndexedDBService();


