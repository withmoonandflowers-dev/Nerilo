import Dexie, { type Table } from 'dexie';
import type { GossipMessage } from '../types';
import type { IGossipPersistence } from '../core/mesh/GossipPersistence';
import { logger } from '../utils/logger';

/**
 * 複本持久層（ADR-0023 P1）— IGossipPersistence 的 Dexie 實作。
 *
 * 獨立 DB（'NeriloReplica'）而非併入 NeriloDB：避開既有 schema 的
 * 主鍵不可變地雷（見 IndexedDBService v4 註解），且複本語義自成一體。
 * 紀錄存的是「已簽名的完整 GossipMessage」——複本即是對帳補送的資料源，
 * 暫存者只持有（未來為密文的）紀錄本體，簽章隨行可被任何收端驗證。
 */

interface ReplicaRecord {
  /** compound key 的組成欄位 */
  roomId: string;
  senderId: string;
  seq: number;
  /** 完整已簽名紀錄（JSON） */
  recordJson: string;
}

interface ReplicaMeta {
  roomId: string;
  senderId: string;
  /** 淘汰水位：floor 之前不回補 */
  floor?: number;
  /** 自己的 seq 水位：下一個要用的 seq（僅自己的列有意義） */
  nextSeq?: number;
}

class NeriloReplicaDB extends Dexie {
  records!: Table<ReplicaRecord>;
  meta!: Table<ReplicaMeta>;

  constructor() {
    super('NeriloReplica');
    this.version(1).stores({
      records: '[roomId+senderId+seq], roomId',
      meta: '[roomId+senderId]',
    });
  }
}

export class GossipReplicaStore implements IGossipPersistence {
  private db: NeriloReplicaDB;

  constructor() {
    this.db = new NeriloReplicaDB();
  }

  async reserveSeq(roomId: string, senderId: string): Promise<number> {
    // 單一交易內讀+增+寫：同 identity 多分頁併發也不重用
    return this.db.transaction('rw', this.db.meta, async () => {
      const key: [string, string] = [roomId, senderId];
      const meta = await this.db.meta.get(key);
      const seq = meta?.nextSeq ?? 1;
      await this.db.meta.put({ roomId, senderId, floor: meta?.floor, nextSeq: seq + 1 });
      return seq;
    });
  }

  async loadRoom(roomId: string): Promise<{
    records: GossipMessage[];
    floors: Array<{ senderId: string; floor: number }>;
  }> {
    const [rows, metas] = await Promise.all([
      this.db.records.where('roomId').equals(roomId).toArray(),
      this.db.meta.where('[roomId+senderId]').between([roomId, ''], [roomId, '￿']).toArray(),
    ]);
    const records: GossipMessage[] = [];
    for (const r of rows) {
      try {
        records.push(JSON.parse(r.recordJson) as GossipMessage);
      } catch {
        /* 單筆壞資料跳過，不拖垮整房 */
      }
    }
    const floors = metas
      .filter((m) => typeof m.floor === 'number')
      .map((m) => ({ senderId: m.senderId, floor: m.floor as number }));
    return { records, floors };
  }

  async saveRecord(roomId: string, message: GossipMessage): Promise<void> {
    await this.db.records.put({
      roomId,
      senderId: message.senderId,
      seq: message.seq,
      recordJson: JSON.stringify(message),
    });
  }

  async evictRecord(roomId: string, senderId: string, seq: number, newFloor: number): Promise<void> {
    await this.db.transaction('rw', this.db.records, this.db.meta, async () => {
      await this.db.records.delete([roomId, senderId, seq]);
      const key: [string, string] = [roomId, senderId];
      const meta = await this.db.meta.get(key);
      if ((meta?.floor ?? 0) < newFloor) {
        await this.db.meta.put({ roomId, senderId, floor: newFloor, nextSeq: meta?.nextSeq });
      }
    });
  }

  async listRooms(): Promise<string[]> {
    // roomId 有索引；distinct 房 id（uniqueKeys 走索引，不載整表）。
    const keys = await this.db.records.orderBy('roomId').uniqueKeys();
    return keys.map((k) => String(k));
  }
}

let singleton: GossipReplicaStore | null = null;

/**
 * lazy 單例：只在真正需要時建構（node 測試環境沒有 indexedDB，
 * import 本模組必須無副作用）。失敗回 null → 呼叫端退回記憶體模式。
 */
export function getGossipReplicaStore(): IGossipPersistence | null {
  if (singleton) return singleton;
  try {
    if (typeof indexedDB === 'undefined') return null;
    singleton = new GossipReplicaStore();
    return singleton;
  } catch (err) {
    logger.warn('[GossipReplicaStore] unavailable, falling back to memory-only', err);
    return null;
  }
}
