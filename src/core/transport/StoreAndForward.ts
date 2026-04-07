/**
 * Store-and-Forward Service
 *
 * 當對等端離線時，將訊息暫存至 Firestore，待對方上線後投遞。
 *
 * 設計：
 * - 每個房間有一個 `inbox/{recipientUid}` 子集合
 * - 發送端偵測 P2P 連線失敗時，寫入 inbox
 * - 接收端上線時（加入房間 / 恢復前景）訂閱並消費 inbox
 * - 訊息帶 TTL（預設 7 天），過期由 Cloud Function 清除
 * - 單則訊息上限 64KB（與 Firestore relay 一致）
 *
 * 資料結構：
 *   /p2pRooms/{roomId}/inbox/{recipientUid}/messages/{docId}
 *   {
 *     from: string,
 *     payload: string,        // JSON-serialized P2PEnvelope
 *     createdAt: Timestamp,
 *     expiresAt: Timestamp,
 *   }
 */

import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  from: string;
  payload: string;
  createdAt: unknown; // serverTimestamp sentinel or Timestamp
  expiresAt: Timestamp;
}

export interface StoreAndForwardConfig {
  /** 訊息 TTL（毫秒），預設 7 天 */
  messageTtlMs?: number;
  /** 單則訊息最大 bytes，預設 64KB */
  maxPayloadBytes?: number;
  /** 批次消費上限，預設 100 則 */
  drainBatchSize?: number;
}

type InboxHandler = (from: string, payload: string) => void;

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;         // 64 KB
const DEFAULT_DRAIN_BATCH_SIZE = 100;

// ── Service ──────────────────────────────────────────────────────────────────

export class StoreAndForward {
  private messageTtlMs: number;
  private maxPayloadBytes: number;
  private drainBatchSize: number;
  private subscriptions: Unsubscribe[] = [];

  constructor(config: StoreAndForwardConfig = {}) {
    this.messageTtlMs = config.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
    this.maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.drainBatchSize = config.drainBatchSize ?? DEFAULT_DRAIN_BATCH_SIZE;
  }

  /**
   * 將訊息存入目標使用者的 inbox（當對方離線時使用）
   */
  async store(
    roomId: string,
    recipientUid: string,
    fromUid: string,
    payload: string
  ): Promise<string> {
    // 大小檢查
    const payloadSize = new Blob([payload]).size;
    if (payloadSize > this.maxPayloadBytes) {
      throw new Error(
        `[StoreAndForward] Payload exceeds ${this.maxPayloadBytes} bytes limit (got ${payloadSize})`
      );
    }

    const inboxCol = this.getInboxCollection(roomId, recipientUid);
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(now.toMillis() + this.messageTtlMs);

    const doc: StoredMessage = {
      from: fromUid,
      payload,
      createdAt: serverTimestamp(),
      expiresAt,
    };

    const docRef = await addDoc(inboxCol, doc);
    logger.info('[StoreAndForward] Message stored', {
      roomId,
      to: recipientUid,
      from: fromUid,
      docId: docRef.id,
      expiresAt: expiresAt.toMillis(),
    });

    return docRef.id;
  }

  /**
   * 訂閱 inbox（即時監聽新到達的暫存訊息）
   * 適合在使用者加入房間時啟動。
   */
  subscribe(
    roomId: string,
    myUid: string,
    handler: InboxHandler
  ): Unsubscribe {
    const inboxCol = this.getInboxCollection(roomId, myUid);
    const q = query(
      inboxCol,
      where('expiresAt', '>', Timestamp.now()),
      orderBy('expiresAt', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const data = change.doc.data() as StoredMessage;
          try {
            handler(data.from, data.payload);
          } catch (err) {
            logger.error('[StoreAndForward] Handler error', err);
          }
          // 消費後刪除
          deleteDoc(change.doc.ref).catch((e) =>
            logger.warn('[StoreAndForward] Failed to delete consumed message', e)
          );
        }
      }
    });

    this.subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * 一次性排空 inbox 中的所有未過期訊息
   * 適合在重新連線 / 恢復前景時使用。
   */
  async drain(
    roomId: string,
    myUid: string,
    handler: InboxHandler
  ): Promise<number> {
    const inboxCol = this.getInboxCollection(roomId, myUid);
    const q = query(
      inboxCol,
      where('expiresAt', '>', Timestamp.now()),
      orderBy('expiresAt', 'asc')
    );

    const snapshot = await getDocs(q);
    let consumed = 0;

    for (const doc of snapshot.docs) {
      if (consumed >= this.drainBatchSize) break;

      const data = doc.data() as StoredMessage;
      try {
        handler(data.from, data.payload);
        consumed++;
      } catch (err) {
        logger.error('[StoreAndForward] Handler error during drain', err);
      }
      // 消費後刪除
      deleteDoc(doc.ref).catch(() => {});
    }

    if (consumed > 0) {
      logger.info('[StoreAndForward] Drained inbox', {
        roomId,
        uid: myUid,
        consumed,
      });
    }

    return consumed;
  }

  /**
   * 清除指定 inbox 中的過期訊息
   */
  async cleanupExpired(roomId: string, recipientUid: string): Promise<number> {
    const inboxCol = this.getInboxCollection(roomId, recipientUid);
    const q = query(
      inboxCol,
      where('expiresAt', '<', Timestamp.now())
    );

    const snapshot = await getDocs(q);
    const deletions = snapshot.docs.map((doc) => deleteDoc(doc.ref));
    await Promise.allSettled(deletions);

    return snapshot.size;
  }

  /**
   * 取得指定 inbox 中未過期訊息的數量（用於 UI 通知）
   */
  async getPendingCount(roomId: string, myUid: string): Promise<number> {
    const inboxCol = this.getInboxCollection(roomId, myUid);
    const q = query(
      inboxCol,
      where('expiresAt', '>', Timestamp.now())
    );

    const snapshot = await getDocs(q);
    return snapshot.size;
  }

  /**
   * 停止所有訂閱
   */
  destroy(): void {
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];
  }

  // ── 內部 ───────────────────────────────────────────────────────────────

  private getInboxCollection(roomId: string, recipientUid: string) {
    return collection(db, 'p2pRooms', roomId, 'inbox', recipientUid, 'messages');
  }
}
