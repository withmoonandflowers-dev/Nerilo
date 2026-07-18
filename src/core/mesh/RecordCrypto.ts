/**
 * 紀錄密文化（ADR-0023 P2 / ADR-0024 盲信使前置）
 *
 * 把 GossipMessage.content 的明文換成「單一密文信封」，讓非成員（盲信使）
 * 能保存與參與對帳、卻讀不到內容。關鍵不變量：
 *
 *  1. 一則紀錄 = 一個密文（非 per-recipient N 份）→ 盲信使存一份即可、對帳單純。
 *  2. 簽章覆蓋 content 字串（見 SecurityManager）；把密文信封放進 content 後，
 *     簽章即覆蓋密文 → 任何人（含盲信使）都能驗真偽，卻無需金鑰。
 *  3. 明文與密文可共存偵測（mesh 現況為明文）：密文信封是帶版本標記的 JSON，
 *     一般聊天明文不會誤判（見 isEncryptedContent）。
 *
 * 金鑰來源是房間內容金鑰（P2 由 keyx 紀錄分發，見 RoomKeyDistribution；本模組只負責「一則的
 * 加解密」，不管分發——分發設計見 docs/adr/0023 P2 段）。純函數、可獨立測試。
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../../utils/crypto';

/** 密文信封（放進 GossipMessage.content 的序列化字串內容） */
export interface EncryptedContentEnvelope {
  /** 版本/型別標記：'nrec1' = Nerilo record v1，供 isEncryptedContent 偵測 */
  v: 'nrec1';
  /** 密文（Base64，AES-256-GCM） */
  ct: string;
  /** IV（12 bytes，Base64） */
  iv: string;
  /** 內容金鑰 epoch（金鑰輪替時遞增；解密端據此選正確金鑰） */
  ep: number;
}

const MARKER = '"v":"nrec1"';

/**
 * content 字串是否為密文信封。以標記子字串快速排除明文，再嚴格 parse。
 * 明文聊天訊息即使剛好是 JSON 也不會含此專屬標記，不會誤判。
 */
export function isEncryptedContent(content: string): boolean {
  if (typeof content !== 'string' || !content.includes(MARKER)) return false;
  try {
    const o = JSON.parse(content) as Partial<EncryptedContentEnvelope>;
    return o?.v === 'nrec1' && typeof o.ct === 'string' && typeof o.iv === 'string';
  } catch {
    return false;
  }
}

/** 用房間內容金鑰加密明文 → content 字串（可簽、可放進 GossipMessage.content） */
export async function encryptRecordContent(
  plaintext: string,
  roomKey: CryptoKey,
  epoch = 0
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    roomKey,
    new TextEncoder().encode(plaintext)
  );
  const env: EncryptedContentEnvelope = {
    v: 'nrec1',
    ct: arrayBufferToBase64(ct),
    iv: arrayBufferToBase64(iv.buffer),
    ep: epoch,
  };
  return JSON.stringify(env);
}

/**
 * 解密 content 字串 → 明文。金鑰不符/竄改 → AES-GCM 驗證標籤失敗而拋錯
 * （呼叫端可據此顯示「[無法解密]」，如同備援路徑）。
 */
export async function decryptRecordContent(
  content: string,
  roomKey: CryptoKey
): Promise<string> {
  const env = JSON.parse(content) as EncryptedContentEnvelope;
  if (env.v !== 'nrec1') throw new Error('unrecognized record envelope');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToArrayBuffer(env.iv)) },
    roomKey,
    base64ToArrayBuffer(env.ct)
  );
  return new TextDecoder().decode(pt);
}

/** 讀出信封的 epoch（供解密端選金鑰）；非密文回 null */
export function contentEpoch(content: string): number | null {
  if (!isEncryptedContent(content)) return null;
  try {
    return (JSON.parse(content) as EncryptedContentEnvelope).ep;
  } catch {
    return null;
  }
}
