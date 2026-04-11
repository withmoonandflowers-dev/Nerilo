/**
 * RTDB Relay Fallback
 * When WebRTC direct connection fails, relay messages through Firebase Realtime Database.
 * Only used for control and chat messages (not for bulk/file).
 */

import {
  ref,
  push,
  set,
  get,
  remove,
  onChildAdded,
  query as rtdbQuery,
  orderByChild,
  equalTo,
  type Unsubscribe,
} from 'firebase/database';
import { rtdb } from '../../config/firebase';
import { RTDB } from '../../config/rtdb-paths';
import { logger } from '../../utils/logger';

export interface RelayMessage {
  from: string;
  to: string;
  payload: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

/** Max relay payload size in bytes (64 KB) */
const MAX_RELAY_PAYLOAD_BYTES = 64 * 1024;
/** Relay TTL in ms (30 seconds) */
const RELAY_TTL_MS = 30_000;
/** Cleanup interval in ms (1 minute) */
const CLEANUP_INTERVAL_MS = 60_000;

type RelayHandler = (from: string, payload: string) => void;

export class FirestoreRelay {
  private subscriptions: Unsubscribe[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Send a message through the RTDB relay.
   * @param roomId  P2P room ID
   * @param to      Target user UID
   * @param payload JSON-serialized envelope (must be < 64 KB)
   */
  async send(roomId: string, to: string, from: string, payload: string): Promise<void> {
    if (new Blob([payload]).size > MAX_RELAY_PAYLOAD_BYTES) {
      throw new Error(
        `[FirestoreRelay] Payload exceeds ${MAX_RELAY_PAYLOAD_BYTES} bytes limit`
      );
    }

    const relayRef = ref(rtdb, RTDB.relay(roomId));
    const now = Date.now();
    const expiresAt = now + RELAY_TTL_MS;

    const msg: RelayMessage = {
      from,
      to,
      payload,
      createdAt: now,
      expiresAt,
    };

    const newRef = push(relayRef);
    await set(newRef, msg);
  }

  /**
   * Subscribe to relay messages addressed to this user.
   * @param roomId  P2P room ID
   * @param myUid   Current user's UID
   * @param handler Callback invoked for each incoming relay message
   * @returns Unsubscribe function
   */
  subscribe(roomId: string, myUid: string, handler: RelayHandler): Unsubscribe {
    const relayRef = ref(rtdb, RTDB.relay(roomId));
    const q = rtdbQuery(relayRef, orderByChild('to'), equalTo(myUid));

    const unsubscribe = onChildAdded(q, (snapshot) => {
      const data = snapshot.val() as RelayMessage | null;
      if (!data) return;

      // Client-side expiration filter
      if (data.expiresAt <= Date.now()) {
        // Expired — delete and skip
        remove(snapshot.ref).catch(() => {});
        return;
      }

      handler(data.from, data.payload);

      // Delete the entry after reading (fire-and-forget)
      remove(snapshot.ref).catch(() => {});
    });

    this.subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * Start periodic cleanup of expired relay entries.
   */
  startCleanup(roomId: string): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanup(roomId).catch((err) => {
        logger.warn('[FirestoreRelay] Cleanup error', err);
      });
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Delete expired relay entries for a room.
   */
  async cleanup(roomId: string): Promise<number> {
    const relayRef = ref(rtdb, RTDB.relay(roomId));
    const snapshot = await get(relayRef);

    if (!snapshot.exists()) return 0;

    let deleted = 0;
    const now = Date.now();
    const batch: Promise<void>[] = [];

    snapshot.forEach((child) => {
      const data = child.val() as RelayMessage | null;
      if (data && data.expiresAt < now) {
        batch.push(remove(child.ref));
        deleted++;
      }
    });

    await Promise.allSettled(batch);
    if (deleted > 0) {
      logger.info('[FirestoreRelay] Cleaned up expired entries', {
        roomId,
        count: deleted,
      });
    }
    return deleted;
  }

  /**
   * Stop all subscriptions and cleanup timer.
   */
  destroy(): void {
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
