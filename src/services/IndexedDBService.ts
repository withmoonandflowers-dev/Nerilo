import Dexie, { Table } from 'dexie';
import type { ChatMessage, FileMetadata, LedgerEntry } from '../types';

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

/**
 * 區塊鏈帳本條目持久化記錄
 * 對應 SharedDataStream 的 LedgerEntry，額外加入 roomId 以便查詢
 */
interface ChainRecord {
  id?: number;
  /** 對應 LedgerEntry.entryHash，全域唯一 */
  entryHash: string;
  entryIndex: number;
  previousHash: string;
  payloadHash: string;
  timestamp: number;
  creatorId: string;
  /** JSON 序列化後的 payload */
  payloadJson: string;
  /** 選填：訊息簽名（Base64）*/
  signature?: string;
  roomId: string;
}

class NeriloDB extends Dexie {
  chats!: Table<ChatRecord>;
  files!: Table<FileRecord>;
  events!: Table<SystemEvent>;
  chainEntries!: Table<ChainRecord>;

  constructor() {
    super('NeriloDB');

    this.version(1).stores({
      chats: '++id, messageId, timestamp, roomId, from',
      files: '++id, fileId, timestamp, roomId',
      events: '++id, eventId, timestamp, roomId, type',
    });

    // v2：新增 chainEntries 表（區塊鏈帳本持久化）
    this.version(2).stores({
      chats: '++id, messageId, timestamp, roomId, from',
      files: '++id, fileId, timestamp, roomId',
      events: '++id, eventId, timestamp, roomId, type',
      chainEntries: '++id, entryHash, entryIndex, roomId, timestamp, creatorId',
    });
  }
}

export class IndexedDBService {
  private db: NeriloDB;

  constructor() {
    this.db = new NeriloDB();
  }

  // ── 聊天紀錄 ──────────────────────────────────────────────────────────────

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

  // ── 檔案 metadata ──────────────────────────────────────────────────────────

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

  // ── 系統事件 ───────────────────────────────────────────────────────────────

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

  // ── 區塊鏈帳本（ChainEntries）─────────────────────────────────────────────

  /**
   * 儲存單筆帳本條目到 IndexedDB
   * 由 ChainSyncService 在 SharedDataStream.onEntryAppended 時呼叫
   */
  async saveChainEntry(entry: LedgerEntry, roomId: string): Promise<void> {
    // 避免重複寫入（entryHash 已存在則跳過）
    const existing = await this.db.chainEntries.where('entryHash').equals(entry.entryHash).first();
    if (existing) return;

    await this.db.chainEntries.add({
      entryHash: entry.entryHash,
      entryIndex: entry.index,
      previousHash: entry.previousHash,
      payloadHash: entry.payloadHash,
      timestamp: entry.timestamp,
      creatorId: entry.creatorId,
      payloadJson: JSON.stringify(entry.payload),
      signature: entry.signature,
      roomId,
    });
  }

  /**
   * 取得特定房間的所有帳本條目（依 index 排序）
   * 用於啟動時從本地還原鏈或傳給新加入的 peer
   */
  async getChainEntries(roomId: string): Promise<LedgerEntry[]> {
    const records = await this.db.chainEntries
      .where('roomId')
      .equals(roomId)
      .sortBy('entryIndex');

    return records.map((r) => ({
      index: r.entryIndex,
      previousHash: r.previousHash,
      payloadHash: r.payloadHash,
      timestamp: r.timestamp,
      creatorId: r.creatorId,
      payload: JSON.parse(r.payloadJson),
      signature: r.signature,
      entryHash: r.entryHash,
    }));
  }

  /**
   * 取得最後一筆帳本條目（用於快速確認本地鏈長度）
   */
  async getLastChainEntry(roomId: string): Promise<LedgerEntry | null> {
    const record = await this.db.chainEntries
      .where('roomId')
      .equals(roomId)
      .last();

    if (!record) return null;

    return {
      index: record.entryIndex,
      previousHash: record.previousHash,
      payloadHash: record.payloadHash,
      timestamp: record.timestamp,
      creatorId: record.creatorId,
      payload: JSON.parse(record.payloadJson),
      signature: record.signature,
      entryHash: record.entryHash,
    };
  }

  /**
   * 刪除特定房間的帳本條目
   * 於使用者「離開房間」或「加入新房間」時呼叫，確保不攜帶舊鏈
   */
  async clearChainEntries(roomId: string): Promise<void> {
    await this.db.chainEntries.where('roomId').equals(roomId).delete();
  }

  // ── 清除資料 ───────────────────────────────────────────────────────────────

  /**
   * 清除特定房間所有資料（聊天、檔案、事件、帳本鏈）
   * 使用者離開或加入新房間時呼叫
   */
  async clearRoomData(roomId: string): Promise<void> {
    await Promise.all([
      this.db.chats.where('roomId').equals(roomId).delete(),
      this.db.files.where('roomId').equals(roomId).delete(),
      this.db.events.where('roomId').equals(roomId).delete(),
      this.db.chainEntries.where('roomId').equals(roomId).delete(),
    ]);
  }

  async clearAllData(): Promise<void> {
    await Promise.all([
      this.db.chats.clear(),
      this.db.files.clear(),
      this.db.events.clear(),
      this.db.chainEntries.clear(),
    ]);
  }
}

export const indexedDBService = new IndexedDBService();
