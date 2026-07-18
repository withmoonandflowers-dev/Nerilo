/**
 * Firestore 備援聊天：當 P2P 未連線時，經由 Firestore 收發訊息，確保聊天室仍可使用。
 *
 * ADR-0004：星型房間的備援訊息一律以 sender key 加密後寫入（encrypted 欄位），
 * Firestore 只見密文與路由 metadata。明文 content 欄位僅供未啟用 E2EE 的拓撲使用。
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
import { connectionStats } from '../core/metrics/ConnectionStats';
import type { ChatMessage } from '../types';

const MESSAGES_LIMIT = 100;
const FALLBACK_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** fallback 密文 payload（與 P2P EncryptedChatPayload.encrypted 同形） */
export interface FallbackEncryptedContent {
  ciphertext: string; // Base64
  iv: string; // Base64
  senderKeyEpoch: number;
  seq?: number;
}

export type FallbackMessageBody =
  | { content: string }
  | { encrypted: FallbackEncryptedContent };

/**
 * 發送一則訊息到 Firestore（備援路徑）
 *
 * 注意：firestore.rules 要求 createdAt 在伺服器時間 ±30 秒內（防重放），
 * 因此必須同時寫入 createdAt；timestamp 保留供既有讀取端相容。
 *
 * @param providedMessageId 呼叫端的樂觀顯示 id。必須貫穿寫入，否則 onSnapshot
 * 把自己的訊息以「另一個 id」回吐（明文路徑不跳過自己），寄件方畫面出現兩顆泡泡。
 */
export async function sendMessageViaFirestore(
  roomId: string,
  uid: string,
  body: FallbackMessageBody,
  providedMessageId?: string
): Promise<string> {
  const messageId = providedMessageId ?? generateUUID();
  connectionStats.recordFallbackMessage(); // P0 量測：fallback 觸發率（社群中繼投資決策依據）
  const messagesRef = collection(db, 'p2pRooms', roomId, 'messages');
  const now = Timestamp.now();
  await addDoc(messagesRef, {
    messageId,
    from: uid,
    ...body,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + FALLBACK_MESSAGE_TTL_MS),
    timestamp: now,
    edited: false,
    deleted: false,
  });
  return messageId;
}

export interface SubscribeOptions {
  /** 本機 uid：略過自己的密文訊息（本機已有明文回顯，且無法解密自己的密文） */
  localUid?: string;
  /** 解密器：通常是 ChatService.decryptFromFallback 的綁定 */
  decrypt?: (
    payload: FallbackEncryptedContent,
    senderId: string
  ) => Promise<string>;
  /**
   * 解不開時「跳過」而非入列佔位訊息（Spec 012 rejoin 回歸修復）。
   * mesh 房的權威副本在 gossip 複寫日誌（anti-entropy 會補齊並以同 messageId 呈現明文）；
   * 佔位訊息一旦先入列，id 去重會永久擋住稍後可解密的好副本。onSnapshot 的 'added'
   * 是一次性事件，佔位沒有第二次機會——故 mesh 房應跳過。星型房「不可」跳過：
   * 備援是 P2P 斷線時唯一投遞路徑，跳過＝訊息永久消失，佔位是誠實呈現。
   * 以函數形式在到訊當下評估（星型→mesh 遷移期拓撲會變）。
   */
  skipUndecryptable?: boolean | (() => boolean);
}

/**
 * 訂閱該房間的 Firestore 訊息，並以 ChatMessage 格式回呼
 * @returns 取消訂閱的函式
 */
export function subscribeToFirestoreMessages(
  roomId: string,
  onMessage: (message: ChatMessage) => void,
  options?: SubscribeOptions
): () => void {
  const messagesRef = collection(db, 'p2pRooms', roomId, 'messages');
  const q = query(
    messagesRef,
    orderBy('timestamp', 'asc'),
    limit(MESSAGES_LIMIT)
  );

  // 逐則依序處理（解密為非同步，串列化以維持訊息順序）
  let chain: Promise<void> = Promise.resolve();

  const unsubscribe = onSnapshot(q, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;
      const data = change.doc.data();

      chain = chain.then(async () => {
        const ts = data.timestamp;
        const base = {
          messageId: data.messageId as string,
          from: data.from as string,
          timestamp: ts?.toMillis?.() ?? ts ?? Date.now(),
          edited: (data.edited as boolean) ?? false,
          deleted: (data.deleted as boolean) ?? false,
        };

        if (data.encrypted) {
          // 自己的密文：本機已有明文回顯，略過（sender key 無法解密自己的訊息）
          if (options?.localUid && data.from === options.localUid) return;

          let content: string | null = null;
          if (options?.decrypt) {
            try {
              content = await options.decrypt(
                data.encrypted as FallbackEncryptedContent,
                data.from as string
              );
            } catch {
              // 金鑰不在手上（重整後或未完成交換）：依拓撲決定佔位或跳過（見 SubscribeOptions）
            }
          }
          if (content === null) {
            const skip =
              typeof options?.skipUndecryptable === 'function'
                ? options.skipUndecryptable()
                : (options?.skipUndecryptable ?? false);
            if (skip) return; // mesh 房：讓 gossip 權威副本以同 id 呈現，不佔位擋路
            content = '[無法解密此訊息]';
          }
          onMessage({ ...base, content });
        } else {
          onMessage({ ...base, content: (data.content as string) ?? '' });
        }
      });
    }
  });

  return unsubscribe;
}
