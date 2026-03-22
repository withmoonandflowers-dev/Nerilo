/**
 * Firestore 備援聊天：當 P2P 未連線時，經由 Firestore 收發訊息，確保聊天室仍可使用。
 */

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../config/firebase';
import { generateUUID } from '../utils/uuid';
import type { ChatMessage } from '../types';

const MESSAGES_LIMIT = 100;

/**
 * 發送一則訊息到 Firestore（備援路徑）
 */
export async function sendMessageViaFirestore(
  roomId: string,
  uid: string,
  content: string
): Promise<string> {
  const messageId = generateUUID();
  const messagesRef = collection(db, 'p2pRooms', roomId, 'messages');
  await addDoc(messagesRef, {
    messageId,
    from: uid,
    content,
    timestamp: Timestamp.now(),
    edited: false,
    deleted: false,
  });
  return messageId;
}

/**
 * 訂閱該房間的 Firestore 訊息，並以 ChatMessage 格式回呼
 * @returns 取消訂閱的函式
 */
export function subscribeToFirestoreMessages(
  roomId: string,
  onMessage: (message: ChatMessage) => void
): () => void {
  const messagesRef = collection(db, 'p2pRooms', roomId, 'messages');
  const q = query(
    messagesRef,
    orderBy('timestamp', 'asc'),
    limit(MESSAGES_LIMIT)
  );

  const unsubscribe = onSnapshot(q, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;
      const data = change.doc.data();
      const ts = data.timestamp;
      const message: ChatMessage = {
        messageId: data.messageId,
        from: data.from,
        content: data.content,
        timestamp: ts?.toMillis?.() ?? ts ?? Date.now(),
        edited: data.edited ?? false,
        deleted: data.deleted ?? false,
      };
      onMessage(message);
    }
  });

  return unsubscribe;
}
