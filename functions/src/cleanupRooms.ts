/**
 * Scheduled Cloud Functions for room, signal, inbox, and relay cleanup.
 *
 * Uses Firebase Realtime Database (not Firestore).
 *
 * RTDB structure:
 *   /rooms/{roomId}          — room metadata (ttlExpireAt, status, participants: {uid: true})
 *   /signals/{roomId}/{key}  — signaling entries (createdAt)
 *   /inbox/{roomId}/{uid}/{msgId} — store-and-forward messages (expiresAt)
 *   /relay/{roomId}/{msgId}  — relay messages (expiresAt)
 *
 * cleanupExpiredRooms:   runs every hour, deletes rooms past ttlExpireAt
 * cleanupStaleSignals:   runs every 5 minutes, deletes old signaling entries
 * cleanupExpiredInbox:   runs every 30 minutes, deletes expired inbox messages
 * cleanupExpiredRelay:   runs every 30 minutes, deletes expired relay messages
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

/**
 * Cleanup expired rooms — runs every hour.
 * 1. Query rooms where ttlExpireAt < now (limited to 100)
 * 2. For each expired room, delete its signals, inbox, relay data and the room itself
 */
export const cleanupExpiredRooms = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    const db = admin.database();
    const now = Date.now();

    const expiredSnapshot = await db
      .ref('rooms')
      .orderByChild('ttlExpireAt')
      .endAt(now)
      .limitToFirst(100)
      .once('value');

    if (!expiredSnapshot.exists()) {
      console.log('[cleanupExpiredRooms] No expired rooms found');
      return null;
    }

    let deletedCount = 0;
    const updates: Record<string, null> = {};

    expiredSnapshot.forEach((roomSnap) => {
      const roomId = roomSnap.key;
      if (!roomId) return;

      // Queue room and all related paths for deletion
      updates[`/rooms/${roomId}`] = null;
      updates[`/signals/${roomId}`] = null;
      updates[`/inbox/${roomId}`] = null;
      updates[`/relay/${roomId}`] = null;
      deletedCount++;
    });

    if (deletedCount > 0) {
      try {
        await db.ref().update(updates);
        console.log(`[cleanupExpiredRooms] Deleted ${deletedCount} expired rooms`);
      } catch (error) {
        console.error('[cleanupExpiredRooms] Failed to delete expired rooms', error);
      }
    }

    return null;
  });

/**
 * Cleanup stale signaling entries — runs every 5 minutes.
 * Iterates /signals/{roomId} and deletes entries where createdAt < 5 minutes ago.
 */
export const cleanupStaleSignals = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const db = admin.database();
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    // Get all signal rooms
    const signalsSnapshot = await db.ref('signals').once('value');

    if (!signalsSnapshot.exists()) {
      return null;
    }

    let totalDeleted = 0;
    const updates: Record<string, null> = {};

    signalsSnapshot.forEach((roomSnap) => {
      const roomId = roomSnap.key;
      if (!roomId) return;

      roomSnap.forEach((signalSnap) => {
        const signalKey = signalSnap.key;
        const data = signalSnap.val();
        if (!signalKey || !data) return;

        if (typeof data.createdAt === 'number' && data.createdAt < fiveMinutesAgo) {
          updates[`/signals/${roomId}/${signalKey}`] = null;
          totalDeleted++;
        }
      });
    });

    if (totalDeleted > 0) {
      try {
        await db.ref().update(updates);
        console.log(`[cleanupStaleSignals] Deleted ${totalDeleted} stale signals`);
      } catch (error) {
        console.error('[cleanupStaleSignals] Failed to delete stale signals', error);
      }
    }

    return null;
  });

/**
 * Cleanup expired store-and-forward inbox messages — runs every 30 minutes.
 *
 * Structure: /inbox/{roomId}/{uid}/{msgId}
 * Deletes messages where expiresAt < now.
 */
export const cleanupExpiredInbox = functions.pubsub
  .schedule('every 30 minutes')
  .onRun(async () => {
    const db = admin.database();
    const now = Date.now();

    const inboxSnapshot = await db.ref('inbox').once('value');

    if (!inboxSnapshot.exists()) {
      console.log('[cleanupExpiredInbox] No inbox data found');
      return null;
    }

    let count = 0;
    const updates: Record<string, null> = {};

    // /inbox/{roomId}/{uid}/{msgId}
    inboxSnapshot.forEach((roomSnap) => {
      const roomId = roomSnap.key;
      if (!roomId) return;

      roomSnap.forEach((uidSnap) => {
        const uid = uidSnap.key;
        if (!uid) return;

        uidSnap.forEach((msgSnap) => {
          const msgKey = msgSnap.key;
          const data = msgSnap.val();
          if (!msgKey || !data) return;

          if (typeof data.expiresAt === 'number' && data.expiresAt < now) {
            updates[`/inbox/${roomId}/${uid}/${msgKey}`] = null;
            count++;
          }
        });
      });
    });

    if (count > 0) {
      try {
        await db.ref().update(updates);
        console.log(`[cleanupExpiredInbox] Deleted ${count} expired inbox messages`);
      } catch (error) {
        console.error('[cleanupExpiredInbox] Failed to delete expired inbox messages', error);
      }
    } else {
      console.log('[cleanupExpiredInbox] No expired inbox messages found');
    }

    return null;
  });

/**
 * Cleanup expired relay messages — runs every 30 minutes.
 *
 * Structure: /relay/{roomId}/{msgId}
 * Deletes messages where expiresAt < now.
 */
export const cleanupExpiredRelay = functions.pubsub
  .schedule('every 30 minutes')
  .onRun(async () => {
    const db = admin.database();
    const now = Date.now();

    const relaySnapshot = await db.ref('relay').once('value');

    if (!relaySnapshot.exists()) {
      console.log('[cleanupExpiredRelay] No relay data found');
      return null;
    }

    let count = 0;
    const updates: Record<string, null> = {};

    // /relay/{roomId}/{msgId}
    relaySnapshot.forEach((roomSnap) => {
      const roomId = roomSnap.key;
      if (!roomId) return;

      roomSnap.forEach((msgSnap) => {
        const msgKey = msgSnap.key;
        const data = msgSnap.val();
        if (!msgKey || !data) return;

        if (typeof data.expiresAt === 'number' && data.expiresAt < now) {
          updates[`/relay/${roomId}/${msgKey}`] = null;
          count++;
        }
      });
    });

    if (count > 0) {
      try {
        await db.ref().update(updates);
        console.log(`[cleanupExpiredRelay] Deleted ${count} expired relay messages`);
      } catch (error) {
        console.error('[cleanupExpiredRelay] Failed to delete expired relay messages', error);
      }
    } else {
      console.log('[cleanupExpiredRelay] No expired relay messages found');
    }

    return null;
  });
