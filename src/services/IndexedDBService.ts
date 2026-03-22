import Dexie, { Table } from 'dexie';
import type { ChatMessage, FileMetadata, LedgerEntry, LedgerEntryWithProvenance, LedgerSnapshot } from '../types';

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
 * 區塊鏈帳本條目持久化記錄（v3 schema）
 *
 * isProvenance = 1 代表此條目來自另一個房間（合併/分岔繼承），
 * 不屬於 roomId 房間自身的 hash 鏈，但在歷史顯示時合併呈現。
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
  /** 此條目所屬的「當前房間」（用於查詢）*/
  roomId: string;
  /**
   * 0 = 本房間自身鏈的條目
   * 1 = 來自另一個房間的 provenance 條目（合併/分岔繼承的歷史）
   */
  isProvenance: 0 | 1;
  /** 若 isProvenance=1，記錄原始房間 ID */
  sourceRoomId?: string;
  /** 繼承方式：'merge' = 合併而來；'split' = 分岔繼承 */
  provenanceOperation?: 'merge' | 'split';
}

interface SnapshotRecord {
  snapshotId: string;
  roomId: string;
  upToIndex: number;
  tipHash: string;
  stateHash: string;
  createdAt: number;
  creatorId: string;
  chunksJson: string; // JSON.stringify(chunks)
}

interface FeatureStateRecord {
  key: string;
  roomId: string;
  valueJson: string;
}

class NeriloDB extends Dexie {
  chats!: Table<ChatRecord>;
  files!: Table<FileRecord>;
  events!: Table<SystemEvent>;
  chainEntries!: Table<ChainRecord>;
  snapshots!: Table<SnapshotRecord>;
  featureState!: Table<FeatureStateRecord>;

  constructor() {
    super('NeriloDB');

    this.version(1).stores({
      chats: '++id, messageId, timestamp, roomId, from',
      files: '++id, fileId, timestamp, roomId',
      events: '++id, eventId, timestamp, roomId, type',
    });

    // v2：新增 chainEntries 表
    this.version(2).stores({
      chats: '++id, messageId, timestamp, roomId, from',
      files: '++id, fileId, timestamp, roomId',
      events: '++id, eventId, timestamp, roomId, type',
      chainEntries: '++id, entryHash, entryIndex, roomId, timestamp, creatorId',
    });

    // v3：chainEntries 加入 isProvenance、sourceRoomId 索引，支援 provenance 查詢
    this.version(3)
      .stores({
        chats: '++id, messageId, timestamp, roomId, from',
        files: '++id, fileId, timestamp, roomId',
        events: '++id, eventId, timestamp, roomId, type',
        chainEntries:
          '++id, entryHash, entryIndex, roomId, timestamp, creatorId, isProvenance, sourceRoomId',
      })
      .upgrade(async (tx) => {
        // 為既有條目補上 isProvenance = 0
        await tx
          .table('chainEntries')
          .toCollection()
          .modify((rec: any) => {
            if (rec.isProvenance === undefined) rec.isProvenance = 0;
          });
      });

    // v4: add snapshots and featureState tables
    this.version(4)
      .stores({
        chats: 'messageId, timestamp, roomId, from',
        files: 'fileId, timestamp, roomId',
        events: 'eventId, timestamp, roomId, type',
        chainEntries:
          'entryHash, entryIndex, roomId, timestamp, creatorId, [roomId+isProvenance], isProvenance, sourceRoomId',
        snapshots: 'snapshotId, roomId, upToIndex, createdAt',
        featureState: 'key, roomId',
      })
      .upgrade(() => {
        // No data migration needed for new tables
      });
  }
}

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function recordToEntry(r: ChainRecord): LedgerEntry {
  return {
    index: r.entryIndex,
    previousHash: r.previousHash,
    payloadHash: r.payloadHash,
    timestamp: r.timestamp,
    creatorId: r.creatorId,
    payload: JSON.parse(r.payloadJson),
    signature: r.signature,
    entryHash: r.entryHash,
  };
}

function recordToEntryWithProvenance(r: ChainRecord): LedgerEntryWithProvenance {
  return {
    ...recordToEntry(r),
    isProvenance: r.isProvenance === 1,
    sourceRoomId: r.sourceRoomId,
    provenanceOperation: r.provenanceOperation,
  };
}

// ── IndexedDBService ──────────────────────────────────────────────────────────

export class IndexedDBService {
  private db: NeriloDB;

  constructor() {
    this.db = new NeriloDB();
  }

  // ── 聊天紀錄 ─────────────────────────────────────────────────────────────

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
    if (record?.id !== undefined) {
      await this.db.chats.update(record.id, updates);
    }
  }

  async deleteChatMessage(messageId: string): Promise<void> {
    await this.db.chats.where('messageId').equals(messageId).delete();
  }

  // ── 檔案 metadata ─────────────────────────────────────────────────────────

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

  // ── 系統事件 ──────────────────────────────────────────────────────────────

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

  // ── 區塊鏈帳本：主鏈條目（isProvenance = 0）────────────────────────────────

  /**
   * 儲存本房間自身的帳本條目（由 ChainSyncService.onEntryAppended 呼叫）
   */
  async saveChainEntry(entry: LedgerEntry, roomId: string): Promise<void> {
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
      isProvenance: 0,
    });
  }

  /**
   * 取得本房間自身的帳本條目（不含 provenance），依 index 排序
   */
  async getChainEntries(roomId: string): Promise<LedgerEntry[]> {
    const records = await this.db.chainEntries
      .where('[roomId+isProvenance]')
      .equals([roomId, 0])
      .sortBy('entryIndex');

    return records.map(recordToEntry);
  }

  /**
   * 取得本房間最後一筆自身條目（快速確認鏈長度）
   */
  async getLastChainEntry(roomId: string): Promise<LedgerEntry | null> {
    const records = await this.db.chainEntries
      .where('[roomId+isProvenance]')
      .equals([roomId, 0])
      .sortBy('entryIndex');

    const last = records[records.length - 1];
    return last ? recordToEntry(last) : null;
  }

  /**
   * 清除本房間自身的帳本條目（不影響 provenance）
   */
  async clearChainEntries(roomId: string): Promise<void> {
    await this.db.chainEntries
      .where('[roomId+isProvenance]')
      .equals([roomId, 0])
      .delete();
  }

  // ── 區塊鏈帳本：Provenance 條目（isProvenance = 1）───────────────────────

  /**
   * 批次儲存 provenance 條目（來自另一個房間的歷史，合併/分岔時繼承）
   *
   * @param entries         原始房間的帳本條目列表
   * @param targetRoomId    目前房間 ID（儲存於 roomId 欄位，用於查詢）
   * @param sourceRoomId    原始房間 ID
   * @param operation       'merge' = 合併而來；'split' = 分岔繼承
   */
  async saveProvenanceEntries(
    entries: LedgerEntry[],
    targetRoomId: string,
    sourceRoomId: string,
    operation: 'merge' | 'split'
  ): Promise<void> {
    const existing = new Set(
      (
        await this.db.chainEntries
          .where('sourceRoomId')
          .equals(sourceRoomId)
          .filter((r) => r.roomId === targetRoomId && r.isProvenance === 1)
          .toArray()
      ).map((r) => r.entryHash)
    );

    const toAdd: ChainRecord[] = entries
      .filter((e) => !existing.has(e.entryHash))
      .map((e) => ({
        entryHash: e.entryHash,
        entryIndex: e.index,
        previousHash: e.previousHash,
        payloadHash: e.payloadHash,
        timestamp: e.timestamp,
        creatorId: e.creatorId,
        payloadJson: JSON.stringify(e.payload),
        signature: e.signature,
        roomId: targetRoomId,
        isProvenance: 1 as const,
        sourceRoomId,
        provenanceOperation: operation,
      }));

    if (toAdd.length > 0) {
      await this.db.chainEntries.bulkAdd(toAdd);
    }
  }

  /**
   * 取得本房間的所有 provenance 條目
   * 依 sourceRoomId 分組，每組內依 entryIndex 排序
   */
  async getProvenanceEntries(
    roomId: string
  ): Promise<Map<string, { operation: 'merge' | 'split'; entries: LedgerEntry[] }>> {
    const records = await this.db.chainEntries
      .where('[roomId+isProvenance]')
      .equals([roomId, 1])
      .toArray();

    const result = new Map<string, { operation: 'merge' | 'split'; entries: LedgerEntry[] }>();
    for (const r of records) {
      const key = r.sourceRoomId!;
      if (!result.has(key)) {
        result.set(key, { operation: r.provenanceOperation!, entries: [] });
      }
      result.get(key)!.entries.push(recordToEntry(r));
    }

    // 每組依 index 排序
    for (const group of result.values()) {
      group.entries.sort((a, b) => a.index - b.index);
    }

    return result;
  }

  /**
   * 清除特定 provenance 來源（例如確認同步完成後清除）
   */
  async clearProvenanceEntries(roomId: string, sourceRoomId?: string): Promise<void> {
    if (sourceRoomId) {
      await this.db.chainEntries
        .where('sourceRoomId')
        .equals(sourceRoomId)
        .filter((r) => r.roomId === roomId && r.isProvenance === 1)
        .delete();
    } else {
      await this.db.chainEntries
        .where('[roomId+isProvenance]')
        .equals([roomId, 1])
        .delete();
    }
  }

  /**
   * 取得完整歷史（主鏈 + 所有 provenance），依 timestamp 排序
   * 用於 UI 顯示（合併後呈現完整時間線）
   */
  async getFullHistory(roomId: string): Promise<LedgerEntryWithProvenance[]> {
    const all = await this.db.chainEntries
      .where('roomId')
      .equals(roomId)
      .toArray();

    return all
      .map(recordToEntryWithProvenance)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  // ── 清除資料 ──────────────────────────────────────────────────────────────

  /**
   * 清除特定房間所有資料（聊天、檔案、事件、帳本主鏈 + provenance）
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

  // ── Snapshots ─────────────────────────────────────────────────────────────

  async saveSnapshot(snapshot: LedgerSnapshot): Promise<void> {
    await this.db.snapshots.put({
      snapshotId: snapshot.snapshotId,
      roomId: snapshot.roomId,
      upToIndex: snapshot.upToIndex,
      tipHash: snapshot.tipHash,
      stateHash: snapshot.stateHash,
      createdAt: snapshot.createdAt,
      creatorId: snapshot.creatorId,
      chunksJson: JSON.stringify(snapshot.chunks),
    });
  }

  async getLatestSnapshot(roomId: string): Promise<LedgerSnapshot | null> {
    const records = await this.db.snapshots
      .where('roomId')
      .equals(roomId)
      .reverse()
      .sortBy('createdAt');

    const latest = records[0];
    if (!latest) return null;
    return this.snapshotRecordToSnapshot(latest);
  }

  async getAllSnapshots(roomId: string): Promise<LedgerSnapshot[]> {
    const records = await this.db.snapshots
      .where('roomId')
      .equals(roomId)
      .sortBy('createdAt');

    return records.map((r) => this.snapshotRecordToSnapshot(r));
  }

  async deleteOldSnapshots(roomId: string, keepCount = 3): Promise<void> {
    const records = await this.db.snapshots
      .where('roomId')
      .equals(roomId)
      .sortBy('createdAt');

    if (records.length <= keepCount) return;

    const toDelete = records.slice(0, records.length - keepCount);
    const idsToDelete = toDelete.map((r) => r.snapshotId);
    await this.db.snapshots.where('snapshotId').anyOf(idsToDelete).delete();
  }

  private snapshotRecordToSnapshot(r: SnapshotRecord): LedgerSnapshot {
    return {
      snapshotId: r.snapshotId,
      roomId: r.roomId,
      upToIndex: r.upToIndex,
      tipHash: r.tipHash,
      stateHash: r.stateHash,
      createdAt: r.createdAt,
      creatorId: r.creatorId,
      chunks: JSON.parse(r.chunksJson) as string[],
    };
  }

  // ── Feature State ─────────────────────────────────────────────────────────

  async getFeatureState(roomId: string, key: string): Promise<unknown> {
    const compositeKey = `${roomId}:${key}`;
    const record = await this.db.featureState.where('key').equals(compositeKey).first();
    if (!record) return undefined;
    return JSON.parse(record.valueJson) as unknown;
  }

  async setFeatureState(roomId: string, key: string, value: unknown): Promise<void> {
    const compositeKey = `${roomId}:${key}`;
    await this.db.featureState.put({
      key: compositeKey,
      roomId,
      valueJson: JSON.stringify(value),
    });
  }

  async deleteFeatureState(roomId: string, key: string): Promise<void> {
    const compositeKey = `${roomId}:${key}`;
    await this.db.featureState.where('key').equals(compositeKey).delete();
  }
}

export const indexedDBService = new IndexedDBService();
