/**
 * TombstoneCrypto — 盲信使可驗的房籍簽章墓碑（ADR-0024 Decision 3.3 / ADR-0023 P4-C）
 *
 * 問題：盲信使不知道房間成員名冊（它連內容都解不開），如何驗「這是房裡的人叫我刪」？
 * 觀察：信使代管的每筆密文紀錄都帶寄件人 ECDSA 簽章，senderId = hash(SPKI pubKey)。
 *   凡對該房貢獻過（簽名）紀錄的節點，其 senderId 就在信使的 roomStore 裡。
 * 因此「房籍證明」＝墓碑由「某個 senderId 出現在該房紀錄中的 pubKey」簽署：
 *   非成員從沒對這房送過東西 → senderId 不在 store → 偽造墓碑驗不過。這對盲信使可執行
 *   （只需 pubKey 驗章 + 對照 store 的 senderId 集合），無需知道房間內容或完整名冊。
 *
 * 簽章綁定 `TOMBSTONE|${roomId}`：跨房不可重放（每房獨立字串），且與紀錄簽章
 * （簽的是 JSON 紀錄物件）在原像上不可能碰撞 → 不能拿舊紀錄簽章冒充墓碑。
 * 刪除是冪等的，故不另加 nonce/時效（重放刪除無害）。
 *
 * 純函式、無狀態、無 I/O：用 SubtleCrypto（同 SecurityManager 的 ECDSA P-256/SHA-256 慣例）。
 */

import { arrayBufferToBase64, base64ToArrayBuffer, sha256Hash } from '../../utils/crypto';
import { logger } from '../../utils/logger';

export interface Tombstone {
  roomId: string;
  /** 簽署成員的公鑰（Base64 SPKI）；信使據此驗章並導出 senderId。 */
  pubKey: string;
  /** ECDSA P-256 簽章（Base64），覆蓋 `TOMBSTONE|${roomId}`。 */
  signature: string;
}

/** 墓碑簽章的原像字串：綁 roomId + 用途標籤，跨房不可重放、與紀錄簽章不可混用。 */
function tombstoneCanonical(roomId: string): string {
  return `TOMBSTONE|${roomId}`;
}

/** 原像字串 → SHA-256 digest（ECDSA 簽/驗的輸入）。 */
async function tombstoneDigest(roomId: string): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode(tombstoneCanonical(roomId));
  return crypto.subtle.digest('SHA-256', bytes);
}

/** senderId = hash(Base64 SPKI).slice(0,32)，與 IdentityManager.deriveUserId 完全一致。 */
export async function senderIdFromPubKey(pubKeyBase64: string): Promise<string> {
  const hash = await sha256Hash(pubKeyBase64);
  return hash.substring(0, 32);
}

/**
 * 成員側：以自己的私鑰簽一張房間墓碑。
 * @param pubKeyBase64 自己的公鑰（Base64 SPKI）——需與紀錄裡用的同一把（senderId 才對得上）。
 */
export async function signTombstone(
  roomId: string,
  privateKey: CryptoKey,
  pubKeyBase64: string
): Promise<Tombstone> {
  const digest = await tombstoneDigest(roomId);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, digest);
  return { roomId, pubKey: pubKeyBase64, signature: arrayBufferToBase64(sig) };
}

/**
 * 信使側（盲）：驗證墓碑。兩關都過才算合法：
 *  1. 簽章對 `TOMBSTONE|${roomId}` 用 tombstone.pubKey 驗得過（真的是這把私鑰簽的）。
 *  2. 由 pubKey 導出的 senderId ∈ roomSenderIds（這把鑰匙確實對該房貢獻過紀錄＝房籍）。
 * @param roomSenderIds 該房 store 裡的 senderId 集合（CourierStore.roomStore 的 keys）。
 */
export async function verifyTombstone(
  tombstone: Tombstone,
  roomSenderIds: ReadonlySet<string>
): Promise<boolean> {
  try {
    if (!tombstone || typeof tombstone.pubKey !== 'string' || typeof tombstone.signature !== 'string') {
      return false;
    }
    // 關卡二先做（便宜）：這把鑰匙有沒有房籍。沒有就別費工驗章。
    const senderId = await senderIdFromPubKey(tombstone.pubKey);
    if (!roomSenderIds.has(senderId)) return false;

    // 關卡一：驗章。
    const key = await crypto.subtle.importKey(
      'spki',
      base64ToArrayBuffer(tombstone.pubKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
    const digest = await tombstoneDigest(tombstone.roomId);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToArrayBuffer(tombstone.signature),
      digest
    );
  } catch (err) {
    logger.warn('[TombstoneCrypto] verify failed', { err });
    return false;
  }
}
