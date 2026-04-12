/**
 * RTDB Chat Fallback: when P2P is not connected, send/receive messages
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
 * Send a message via RTDB (fallback path).
 */
export async function sendMessageViaFirestore(
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
 * Subscribe to RTDB messages for a room and invoke the callback with ChatMessage format.
 * @returns Unsubscribe function
 */
export function subscribeToFirestoreMessages(
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
