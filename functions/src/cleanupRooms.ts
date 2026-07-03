/**
 * Scheduled Cloud Functions for room, signal, and inbox cleanup.
 *
 * cleanupExpiredRooms: runs every hour, deletes rooms past ttlExpireAt
 * cleanupStaleSignals: runs every 5 minutes, deletes old signaling docs
 * cleanupExpiredInbox: runs every 30 minutes, deletes expired store-and-forward messages
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const firestore = admin.firestore;

/**
 * Cleanup expired rooms — runs every hour.
 * 1. Query rooms where ttlExpireAt < now
 * 2. Delete signals, relay subcollections
 * 3. Delete room document
 */
export const cleanupExpiredRooms = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    const db = admin.firestore();
    // ttlExpireAt 現為 Firestore Timestamp（配合原生 TTL policy，見 ADR-0006 附錄）。
    // 此函式維持型別一致以備並存部署；正式清理主力是原生 TTL policy。
    const now = admin.firestore.Timestamp.now();

    const expiredSnapshot = await db
      .collection('p2pRooms')
      .where('ttlExpireAt', '<', now)
      .limit(100) // batch limit
      .get();

    if (expiredSnapshot.empty) {
      console.log('[cleanupExpiredRooms] No expired rooms found');
      return null;
    }

    let deletedCount = 0;

    for (const roomDoc of expiredSnapshot.docs) {
      const roomId = roomDoc.id;

      try {
        // Delete signals subcollection
        await deleteSubcollection(db, `p2pRooms/${roomId}/signals`);
        // Delete relay subcollection
        await deleteSubcollection(db, `p2pRooms/${roomId}/relay`);
        // Delete room document
        await roomDoc.ref.delete();
        deletedCount++;
      } catch (error) {
        console.error(`[cleanupExpiredRooms] Failed to delete room ${roomId}`, error);
      }
    }

    console.log(`[cleanupExpiredRooms] Deleted ${deletedCount} expired rooms`);
    return null;
  });

/**
 * Cleanup stale signaling documents — runs every 5 minutes.
 * Deletes signals older than 5 minutes to prevent buildup.
 */
export const cleanupStaleSignals = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const db = admin.firestore();
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    // We need to iterate over rooms with active signals.
    // For efficiency, query rooms that are 'open' or 'waiting'.
    const activeRooms = await db
      .collection('p2pRooms')
      .where('status', 'in', ['open', 'waiting'])
      .limit(50)
      .get();

    let totalDeleted = 0;

    for (const roomDoc of activeRooms.docs) {
      const roomId = roomDoc.id;
      const signalsRef = db.collection(`p2pRooms/${roomId}/signals`);

      const staleSignals = await signalsRef
        .where('createdAt', '<', fiveMinutesAgo)
        .limit(100)
        .get();

      const batch = db.batch();
      let count = 0;

      for (const signalDoc of staleSignals.docs) {
        batch.delete(signalDoc.ref);
        count++;
      }

      if (count > 0) {
        await batch.commit();
        totalDeleted += count;
      }
    }

    if (totalDeleted > 0) {
      console.log(`[cleanupStaleSignals] Deleted ${totalDeleted} stale signals`);
    }
    return null;
  });

/**
 * Helper: delete all documents in a subcollection.
 */
async function deleteSubcollection(
  db: admin.firestore.Firestore,
  path: string
): Promise<void> {
  const collRef = db.collection(path);
  const snapshot = await collRef.limit(500).get();

  if (snapshot.empty) return;

  const batch = db.batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();

  // Recurse if there are more documents
  if (snapshot.size === 500) {
    await deleteSubcollection(db, path);
  }
}

/**
 * Cleanup expired store-and-forward inbox messages — runs every 30 minutes.
 *
 * Structure: /p2pRooms/{roomId}/inbox/{recipientUid}/messages/{docId}
 * Deletes messages where expiresAt < now.
 *
 * Uses collectionGroup query to scan ALL inbox messages across all rooms.
 */
export const cleanupExpiredInbox = functions.pubsub
  .schedule('every 30 minutes')
  .onRun(async () => {
    const db = admin.firestore();
    const now = firestore.Timestamp.now();

    // collectionGroup 查詢所有 "messages" 子集合（inbox 下的）
    const expiredMessages = await db
      .collectionGroup('messages')
      .where('expiresAt', '<', now)
      .limit(500)
      .get();

    if (expiredMessages.empty) {
      console.log('[cleanupExpiredInbox] No expired inbox messages found');
      return null;
    }

    const batch = db.batch();
    let count = 0;

    for (const doc of expiredMessages.docs) {
      // 只處理 inbox 路徑下的文件（避免誤刪其他 "messages" 集合）
      if (doc.ref.path.includes('/inbox/')) {
        batch.delete(doc.ref);
        count++;
      }
    }

    if (count > 0) {
      await batch.commit();
      console.log(`[cleanupExpiredInbox] Deleted ${count} expired inbox messages`);
    }

    return null;
  });
