/**
 * 房間內容金鑰分發（ADR-0023 P2-②b）— 純協議，零 live 接線
 *
 * 世界觀（ADR 修訂三）：內容金鑰本身也是一筆日誌紀錄（channel:'keyx'）。
 * 一把房間內容金鑰，對每個成員各封一份（成對 ECDH 加密）。於是：
 *  - 遲入/重進成員靠既有 anti-entropy 補齊 keyx 紀錄 → 開出金鑰 → 解歷史密文。
 *    金鑰韌性 = 資料韌性，同一套對帳。
 *  - 盲信使照樣保存 keyx 紀錄（每份都是密文）→ 全員斷線回來也能一起補齊。
 *  - 每則訊息仍是「單一密文」（RecordCrypto 用這把房間金鑰），非 per-recipient N 份。
 *
 * 刻意不用 GroupKeyManager 的重機（策略切換/tree-KEM/前向保密輪替）——現階段需求
 * 是「群內共用一把內容金鑰、可經日誌補齊」，用最小 ECDH 封裝即可，風險最低。
 * 前向保密由 epoch 輪替提供（加人/移除時新 epoch + 新 keyx）。
 */

import {
  deriveSharedSecret,
  encryptForPeer,
  decryptFromPeer,
} from '../crypto/ECDHKeyExchange';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';

/** 封給單一成員的房間金鑰（放進 keyx 紀錄 content 的 payload） */
export interface SealedRoomKey {
  /** 收件成員 mesh userId */
  forMember: string;
  /** 內容金鑰 epoch */
  epoch: number;
  /** ECDH 封裝後的房間金鑰（Base64） */
  enc: string;
  /** IV（Base64） */
  iv: string;
}

/** 產生一把可分發的房間內容金鑰（extractable：要匯出後逐一封裝給成員） */
export async function generateRoomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * 把房間金鑰封給某成員：ECDH(myPriv, theirPub) → AES 封裝金鑰原始位元組。
 * 只有持有對應 ECDH 私鑰的該成員能開；盲信使/中繼開不了。
 */
export async function sealRoomKeyForMember(
  roomKey: CryptoKey,
  forMember: string,
  epoch: number,
  myEcdhPrivate: CryptoKey,
  theirEcdhPublic: CryptoKey
): Promise<SealedRoomKey> {
  const raw = await crypto.subtle.exportKey('raw', roomKey);
  const shared = await deriveSharedSecret(myEcdhPrivate, theirEcdhPublic);
  const { ciphertext, iv } = await encryptForPeer(raw, shared);
  return {
    forMember,
    epoch,
    enc: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
  };
}

/**
 * 開出封給自己的房間金鑰：ECDH(myPriv, senderPub) → 解 AES 封裝 → import 成 AES-GCM。
 * 金鑰不符/竄改 → GCM 驗證失敗而拋錯。
 */
export async function openSealedRoomKey(
  sealed: SealedRoomKey,
  myEcdhPrivate: CryptoKey,
  senderEcdhPublic: CryptoKey
): Promise<CryptoKey> {
  const shared = await deriveSharedSecret(myEcdhPrivate, senderEcdhPublic);
  const raw = await decryptFromPeer(
    base64ToArrayBuffer(sealed.enc),
    new Uint8Array(base64ToArrayBuffer(sealed.iv)),
    shared
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * 一次封給多個成員（供產生方廣播 keyx 紀錄集）。
 * 不封給自己（產生方本來就持有明文金鑰）。
 */
export async function sealRoomKeyForAll(
  roomKey: CryptoKey,
  epoch: number,
  myEcdhPrivate: CryptoKey,
  members: Array<{ userId: string; ecdhPublic: CryptoKey }>
): Promise<SealedRoomKey[]> {
  return Promise.all(
    members.map((m) =>
      sealRoomKeyForMember(roomKey, m.userId, epoch, myEcdhPrivate, m.ecdhPublic)
    )
  );
}
