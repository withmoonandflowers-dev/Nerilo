/**
 * Store-and-Forward Service
 *
 * When a peer is offline, temporarily store messages in Firebase RTDB
 * and deliver them when the peer comes back online.
 *
 * Design:
 * - Each room has an `inbox/{roomId}/{recipientUid}` path
 * - Sender writes to inbox when P2P connection fails
 * - Receiver subscribes and consumes inbox on join / foreground resume
 * - Messages carry TTL (default 7 days), expired entries cleaned up periodically
 * - Single message size limit 64KB (same as relay)
 *
 * Data structure:
 *   /inbox/{roomId}/{recipientUid}/{pushId}
 *   {
 *     from: string,
 *     payload: string,        // JSON-serialized P2PEnvelope
 *     createdAt: number,      // epoch ms
 *     expiresAt: number,      // epoch ms
 *   }
 */

import {
  ref,
  push,
  set,
  get,
  remove,
  onChildAdded,
  type Unsubscribe,
} from 'firebase/database';
import { rtdb } from '../../config/firebase';
import { RTDB } from '../../config/rtdb-paths';
import { logger } from '../../utils/logger';

// -- Types --------------------------------------------------------------------

export interface StoredMessage {
  from: string;
  payload: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export interface StoreAndForwardConfig {
  /** Message TTL in ms, default 7 days */
  messageTtlMs?: number;
  /** Max payload bytes per message, default 64KB */
  maxPayloadBytes?: number;
  /** Max messages to consume in one drain batch, default 100 */
  drainBatchSize?: number;
}

type InboxHandler = (from: string, payload: string) => void;

// -- Constants ----------------------------------------------------------------

const DEFAULT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;         // 64 KB
const DEFAULT_DRAIN_BATCH_SIZE = 100;

// -- Service ------------------------------------------------------------------

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
   * Store a message in the target user's inbox (used when peer is offline).
   */
  async store(
    roomId: string,
    recipientUid: string,
    fromUid: string,
    payload: string
  ): Promise<string> {
    // Size check
    const payloadSize = new Blob([payload]).size;
    if (payloadSize > this.maxPayloadBytes) {
      throw new Error(
        `[StoreAndForward] Payload exceeds ${this.maxPayloadBytes} bytes limit (got ${payloadSize})`
      );
    }

    const inboxRef = ref(rtdb, RTDB.inbox(roomId, recipientUid));
    const now = Date.now();
    const expiresAt = now + this.messageTtlMs;

    const msg: StoredMessage = {
      from: fromUid,
      payload,
      createdAt: now,
      expiresAt,
    };

    const newRef = push(inboxRef);
    await set(newRef, msg);

    const docId = newRef.key!;
    logger.info('[StoreAndForward] Message stored', {
      roomId,
      to: recipientUid,
      from: fromUid,
      docId,
      expiresAt,
    });

    return docId;
  }

  /**
   * Subscribe to inbox (real-time listener for newly stored messages).
   * Suitable for starting when the user joins a room.
   */
  subscribe(
    roomId: string,
    myUid: string,
    handler: InboxHandler
  ): Unsubscribe {
    const inboxRef = ref(rtdb, RTDB.inbox(roomId, myUid));

    const unsubscribe = onChildAdded(inboxRef, (snapshot) => {
      const data = snapshot.val() as StoredMessage | null;
      if (!data) return;

      // Client-side expiration filter
      if (data.expiresAt <= Date.now()) {
        remove(snapshot.ref).catch(() => {});
        return;
      }

      try {
        handler(data.from, data.payload);
      } catch (err) {
        logger.error('[StoreAndForward] Handler error', err);
      }

      // Delete after consumption
      remove(snapshot.ref).catch((e) =>
        logger.warn('[StoreAndForward] Failed to delete consumed message', e)
      );
    });

    this.subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * One-shot drain of all unexpired messages in the inbox.
   * Suitable for use on reconnection / foreground resume.
   */
  async drain(
    roomId: string,
    myUid: string,
    handler: InboxHandler
  ): Promise<number> {
    const inboxRef = ref(rtdb, RTDB.inbox(roomId, myUid));
    const snapshot = await get(inboxRef);

    if (!snapshot.exists()) return 0;

    let consumed = 0;
    const now = Date.now();

    snapshot.forEach((child) => {
      if (consumed >= this.drainBatchSize) return;

      const data = child.val() as StoredMessage | null;
      if (!data) return;

      // Skip expired
      if (data.expiresAt <= now) {
        remove(child.ref).catch(() => {});
        return;
      }

      try {
        handler(data.from, data.payload);
        consumed++;
      } catch (err) {
        logger.error('[StoreAndForward] Handler error during drain', err);
      }

      // Delete after consumption
      remove(child.ref).catch(() => {});
    });

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
   * Clean up expired messages in the specified inbox.
   */
  async cleanupExpired(roomId: string, recipientUid: string): Promise<number> {
    const inboxRef = ref(rtdb, RTDB.inbox(roomId, recipientUid));
    const snapshot = await get(inboxRef);

    if (!snapshot.exists()) return 0;

    let deleted = 0;
    const now = Date.now();
    const deletions: Promise<void>[] = [];

    snapshot.forEach((child) => {
      const data = child.val() as StoredMessage | null;
      if (data && data.expiresAt < now) {
        deletions.push(remove(child.ref));
        deleted++;
      }
    });

    await Promise.allSettled(deletions);
    return deleted;
  }

  /**
   * Get the count of unexpired messages in the inbox (for UI notifications).
   */
  async getPendingCount(roomId: string, myUid: string): Promise<number> {
    const inboxRef = ref(rtdb, RTDB.inbox(roomId, myUid));
    const snapshot = await get(inboxRef);

    if (!snapshot.exists()) return 0;

    let count = 0;
    const now = Date.now();

    snapshot.forEach((child) => {
      const data = child.val() as StoredMessage | null;
      if (data && data.expiresAt > now) {
        count++;
      }
    });

    return count;
  }

  /**
   * Stop all subscriptions.
   */
  destroy(): void {
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];
  }
}
