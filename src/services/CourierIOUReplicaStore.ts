import Dexie, { type Table } from 'dexie';
import type { CourierIOUPersistence, CourierIOUSnapshot } from '../core/incentive/CourierIOU';
import { logger } from '../utils/logger';

interface CourierIOURow {
  ownerNodeId: string;
  snapshotJson: string;
  updatedAt: number;
}

class NeriloCourierIOUDB extends Dexie {
  snapshots!: Table<CourierIOURow>;

  constructor() {
    super('NeriloCourierIOU');
    this.version(1).stores({ snapshots: 'ownerNodeId, updatedAt' });
  }
}

/** 每個信使 nodeId 一份完整快照；單列 replace 讓結清與防重放狀態原子更新。 */
export class CourierIOUReplicaStore implements CourierIOUPersistence {
  private readonly db = new NeriloCourierIOUDB();

  async load(ownerNodeId: string): Promise<CourierIOUSnapshot | null> {
    const row = await this.db.snapshots.get(ownerNodeId);
    if (!row) return null;
    try {
      return JSON.parse(row.snapshotJson) as CourierIOUSnapshot;
    } catch {
      await this.db.snapshots.delete(ownerNodeId);
      return null;
    }
  }

  async save(snapshot: CourierIOUSnapshot): Promise<void> {
    await this.db.snapshots.put({
      ownerNodeId: snapshot.ownerNodeId,
      snapshotJson: JSON.stringify(snapshot),
      updatedAt: Date.now(),
    });
  }
}

let singleton: CourierIOUReplicaStore | null = null;

export function getCourierIOUReplicaStore(): CourierIOUPersistence | null {
  if (singleton) return singleton;
  try {
    if (typeof indexedDB === 'undefined') return null;
    singleton = new CourierIOUReplicaStore();
    return singleton;
  } catch (err) {
    logger.warn('[CourierIOUReplicaStore] unavailable, IOU book runs memory-only', err);
    return null;
  }
}
