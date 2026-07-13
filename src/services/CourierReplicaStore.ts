import Dexie, { type Table } from 'dexie';
import type { CourierPersistence, PersistedCourierRecord } from '../core/relay/CourierStore';
import { logger } from '../utils/logger';

/**
 * 盲信使代管的耐久層（ADR-0024 / P4-C 收官）— CourierPersistence 的 Dexie 實作。
 *
 * CourierStore 以記憶體為權威（快取語義）；本層只把代管的「完整密文紀錄」鏡像進 IndexedDB，
 * 讓信使關頁/重載後仍守著別人的密文，回線可補齊。獨立 DB（'NeriloCourier'）與聊天複本
 * （NeriloReplica）分開：語義不同、配額獨立、清空互不影響。信使解不開內容（盲存），
 * 這裡存的就是（未來全為密文的）紀錄本體 + 簽章 + 寄存時刻。
 */

interface CourierRow {
  /** compound key [roomId+senderId+seq] */
  roomId: string;
  senderId: string;
  seq: number;
  /** 完整 GossipMessage（JSON；含密文 content + 簽章） */
  msgJson: string;
  depositedAt: number;
  bytes: number;
}

class NeriloCourierDB extends Dexie {
  records!: Table<CourierRow>;

  constructor() {
    super('NeriloCourier');
    this.version(1).stores({ records: '[roomId+senderId+seq], roomId' });
  }
}

export class CourierReplicaStore implements CourierPersistence {
  private db = new NeriloCourierDB();

  async putRecord(rec: PersistedCourierRecord): Promise<void> {
    await this.db.records.put({
      roomId: rec.roomId,
      senderId: rec.msg.senderId,
      seq: rec.msg.seq,
      msgJson: JSON.stringify(rec.msg),
      depositedAt: rec.depositedAt,
      bytes: rec.bytes,
    });
  }

  async deleteRecord(roomId: string, senderId: string, seq: number): Promise<void> {
    await this.db.records.delete([roomId, senderId, seq]);
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.db.records.where('roomId').equals(roomId).delete();
  }

  async loadAll(): Promise<PersistedCourierRecord[]> {
    const rows = await this.db.records.toArray();
    const out: PersistedCourierRecord[] = [];
    for (const r of rows) {
      try {
        out.push({ roomId: r.roomId, msg: JSON.parse(r.msgJson), depositedAt: r.depositedAt, bytes: r.bytes });
      } catch {
        /* 單筆壞資料跳過，不拖垮整體 hydrate */
      }
    }
    return out;
  }

  async clear(): Promise<void> {
    await this.db.records.clear();
  }
}

let singleton: CourierReplicaStore | null = null;

/** lazy 單例：無 IndexedDB（node 測試）時回 null → CourierStore 退回純記憶體模式。 */
export function getCourierReplicaStore(): CourierPersistence | null {
  if (singleton) return singleton;
  try {
    if (typeof indexedDB === 'undefined') return null;
    singleton = new CourierReplicaStore();
    return singleton;
  } catch (err) {
    logger.warn('[CourierReplicaStore] unavailable, courier runs memory-only', err);
    return null;
  }
}
