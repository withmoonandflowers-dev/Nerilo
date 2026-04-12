/**
 * RTDB Chat Relay: when P2P is not connected, send/receive messages
 * through Firebase Realtime Database to keep the chat room functional.
 */

import {
  ref,
  push,
  set,
  onChildAdded,
  query as rtdbQuery,
  orderByChild,
  limitToLast,
  type Unsubscribe,
} from 'firebase/database';
import { rtdb } from '../config/firebase';
import { RTDB } from '../config/rtdb-paths';
import { generateUUID } from '../utils/uuid';
import type { ChatMessage } from '../types';

const MESSAGES_LIMIT = 100;

/**
 * Send a message via RTDB relay (fallback path when P2P is not connected).
 */
export async function sendMessageViaRelay(
  roomId: string,
  uid: string,
  content: string
): Promise<string> {
  const messageId = generateUUID();
  const relayRef = ref(rtdb, RTDB.relay(roomId));
  const newRef = push(relayRef);
  await set(newRef, {
    messageId,
    from: uid,
    content,
    timestamp: Date.now(),
    edited: false,
    deleted: false,
  });
  return messageId;
}

/**
 * Subscribe to RTDB relay messages for a room.
 * @param myUid - If provided, messages from this uid are filtered out (dedup with optimistic render)
 * @returns Unsubscribe function
 */
export function subscribeToRelayMessages(
  roomId: string,
  onMessage: (message: ChatMessage) => void,
  myUid?: string
): () => void {
  const relayRef = ref(rtdb, RTDB.relay(roomId));
  const q = rtdbQuery(
    relayRef,
    orderByChild('timestamp'),
    limitToLast(MESSAGES_LIMIT)
  );

  const unsubscribe: Unsubscribe = onChildAdded(q, (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    // 過濾自己發的訊息（已由 optimistic render 顯示，避免重複）
    if (myUid && data.from === myUid) return;

    const message: ChatMessage = {
      messageId: data.messageId,
      from: data.from,
      content: data.content,
      timestamp: data.timestamp ?? Date.now(),
      edited: data.edited ?? false,
      deleted: data.deleted ?? false,
    };
    onMessage(message);
  });

  return unsubscribe;
}

// ── Backward-compatible aliases (deprecated) ───────────────────────
/** @deprecated Use sendMessageViaRelay instead */
export const sendMessageViaFirestore = sendMessageViaRelay;
/** @deprecated Use subscribeToRelayMessages instead */
export const subscribeToFirestoreMessages = subscribeToRelayMessages;
