/**
 * FirestoreRelayDirectory — 全站節點名冊的 production adapter（ADR-0023 P4-A）
 *
 * `InMemoryRelayDirectory` 是可測邏輯與模擬用；本檔是跨房、跨裝置的真實名冊：
 * 節點把「我在線、可中繼/可當盲信使」宣告寫進 Firestore `relayDirectory` 集合，
 * 其他節點查詢新鮮宣告來發現彼此。這是站級 overlay（陌生節點互連）的地基——
 * 沒有它，非成員（盲信使）根本找不到要幫誰守護資料。
 *
 * 資料模型：`relayDirectory/{ownerUid}`（一使用者/裝置一則宣告）
 *   { nodeId, ownerUid(=docId, 供 rules 綁 auth), announcedAt, capacity?, regionHint?, metrics? }
 *
 * 安全/隱私（firestore.rules 落實）：
 * - 只能寫自己的（docId==auth.uid、ownerUid==auth.uid）→ 不能冒名/覆寫他人宣告。
 * - 非匿名才可宣告（反女巫）；任何登入者可讀（發現需要）。
 * - announcedAt 需在 server 時間 ±60s（防灌陳舊/未來宣告佔位）。
 * - 宣告不含 IP，只有 nodeId + 粗略 metrics + regionHint（隱私）。
 * - TTL：斷線節點不再續期，query 以 announcedAt 濾除過期（心跳式，死節點自動消失）。
 */

import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';
import type { IRelayDirectory, RelayAnnouncement, RelayQueryOptions } from './RelayDirectory';
import type { RelayNodeMetrics } from './types';

const COLLECTION = 'relayDirectory';

/** Firestore 文件形狀（announcedAt 為 client Date.now()，rules 驗 ±60s 新鮮度） */
interface DirectoryDoc {
  nodeId: string;
  ownerUid: string;
  announcedAt: number;
  capacity?: number;
  regionHint?: string;
  metrics?: Partial<RelayNodeMetrics>;
}

export class FirestoreRelayDirectory implements IRelayDirectory {
  /**
   * @param ownerUid 本節點的 Firebase auth uid（= docId；宣告只能寫在自己名下）。
   * @param ttlMs 宣告新鮮視窗；query 濾除更舊者。預設 30s（配合 ~15s 續期）。
   * @param now 時間來源（測試可注入）。
   */
  constructor(
    private readonly ownerUid: string,
    private readonly ttlMs: number = 30_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** 宣告本節點可中繼/守護（重複宣告 = 續期，覆寫自己那一則）。 */
  async announce(a: RelayAnnouncement): Promise<void> {
    const payload: DirectoryDoc = {
      nodeId: a.nodeId,
      ownerUid: this.ownerUid,
      announcedAt: a.announcedAt,
      ...(a.capacity !== undefined ? { capacity: a.capacity } : {}),
      ...(a.regionHint !== undefined ? { regionHint: a.regionHint } : {}),
      ...(a.metrics !== undefined ? { metrics: a.metrics } : {}),
    };
    await setDoc(doc(db, COLLECTION, this.ownerUid), payload);
  }

  /**
   * 撤回宣告。Firestore 模型下只能撤自己那一則（rules 也只允許刪 docId==自己），
   * 故 nodeId 參數僅為介面相容——一律撤本 ownerUid 的宣告。
   */
  async withdraw(_nodeId: string): Promise<void> {
    try {
      await deleteDoc(doc(db, COLLECTION, this.ownerUid));
    } catch (err) {
      logger.warn('[FirestoreRelayDirectory] withdraw failed', { err });
    }
  }

  /**
   * 查詢新鮮宣告。server 端以 announcedAt 濾 TTL；client 端再濾一次（防時鐘偏差/
   * 索引延遲）並套 exclude/sort/limit——與 InMemoryRelayDirectory 語義一致。
   */
  async query(options: RelayQueryOptions = {}): Promise<RelayAnnouncement[]> {
    const cutoff = this.now() - this.ttlMs;
    let snap;
    try {
      snap = await getDocs(query(collection(db, COLLECTION), where('announcedAt', '>', cutoff)));
    } catch (err) {
      logger.warn('[FirestoreRelayDirectory] query failed', { err });
      return [];
    }
    const fresh: RelayAnnouncement[] = [];
    snap.forEach((d) => {
      const data = d.data() as Partial<DirectoryDoc>;
      if (typeof data.nodeId !== 'string' || typeof data.announcedAt !== 'number') return;
      if (data.announcedAt < cutoff) return; // client 端再濾（防索引延遲/時鐘偏差）
      if (options.excludeNodeId && data.nodeId === options.excludeNodeId) return;
      fresh.push({
        nodeId: data.nodeId,
        announcedAt: data.announcedAt,
        capacity: data.capacity,
        regionHint: data.regionHint,
        metrics: data.metrics,
      });
    });
    // capacity 高者優先，其次較新者（與 InMemory 版一致）
    fresh.sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0) || b.announcedAt - a.announcedAt);
    return options.limit !== undefined ? fresh.slice(0, options.limit) : fresh;
  }
}
