/**
 * Firestore Relay Fallback
 * 當 WebRTC 直連失敗時，透過 Firestore 做訊息 relay。
 * 僅用於 control 和 chat 訊息（不用於 bulk/file）。
 */

import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  getDocs,
  deleteDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';

export interface RelayMessage {
  from: string;
  to: string;
  payload: string;
  createdAt: unknown; // Firestore Timestamp or serverTimestamp sentinel
  expiresAt: Timestamp;
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
   * Send a message through the Firestore relay.
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

    const relayCol = collection(db, 'p2pRooms', roomId, 'relay');
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(now.toMillis() + RELAY_TTL_MS);

    const doc: RelayMessage = {
      from,
      to,
      payload,
      createdAt: serverTimestamp(),
      expiresAt,
    };

    await addDoc(relayCol, doc);
  }

  /**
   * Subscribe to relay messages addressed to this user.
   * @param roomId  P2P room ID
   * @param myUid   Current user's UID
   * @param handler Callback invoked for each incoming relay message
   * @returns Unsubscribe function
   */
  subscribe(roomId: string, myUid: string, handler: RelayHandler): Unsubscribe {
    const relayCol = collection(db, 'p2pRooms', roomId, 'relay');
    const q = query(
      relayCol,
      where('to', '==', myUid),
      where('expiresAt', '>', Timestamp.now())
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const data = change.doc.data() as RelayMessage;
          handler(data.from, data.payload);

          // Delete the doc after reading (fire-and-forget)
          deleteDoc(change.doc.ref).catch(() => {});
        }
      }
    });

    this.subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * Start periodic cleanup of expired relay documents.
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
   * Delete expired relay documents for a room.
   */
  async cleanup(roomId: string): Promise<number> {
    const relayCol = collection(db, 'p2pRooms', roomId, 'relay');
    const q = query(
      relayCol,
      where('expiresAt', '<', Timestamp.now())
    );

    const snapshot = await getDocs(q);
    let deleted = 0;
    const batch: Promise<void>[] = [];

    for (const doc of snapshot.docs) {
      batch.push(deleteDoc(doc.ref));
      deleted++;
    }

    await Promise.allSettled(batch);
    if (deleted > 0) {
      logger.info('[FirestoreRelay] Cleaned up expired docs', {
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
