/**
 * 密碼學工具函數
 */

/**
 * ArrayBuffer 轉 Base64
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 轉 ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** SHA-256 輸出為 64 字元 hex */
export const HASH_HEX_LENGTH = 64;

/** 單次 hash 輸入最大字元數，避免 DoS（約 1MB） */
const MAX_HASH_INPUT_LENGTH = 1_000_000;

/**
 * 計算 SHA-256 hash（非同步）
 * 若輸入超過 MAX_HASH_INPUT_LENGTH 會拋錯以保護效能。
 */
export async function sha256Hash(data: string): Promise<string> {
  if (typeof data !== 'string') {
    throw new TypeError('sha256Hash: data must be a string');
  }
  if (data.length > MAX_HASH_INPUT_LENGTH) {
    throw new RangeError(`sha256Hash: data length ${data.length} exceeds max ${MAX_HASH_INPUT_LENGTH}`);
  }
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 檢查是否為純物件（可安全 JSON 序列化，避免 __proto__ 污染）
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * 計算訊息 ID（用於去重）
 */
export async function getMessageId(message: {
  roomId: string;
  senderId: string;
  seq: number;
  timestamp: number;
  content: string;
}): Promise<string> {
  const content = JSON.stringify({
    roomId: message.roomId,
    senderId: message.senderId,
    seq: message.seq,
    timestamp: message.timestamp,
    content: message.content,
  });
  
  return await sha256Hash(content);
}

/**
 * 計算 payload 的 hash（共享資料流用）
 * payload 必須為純物件，且序列化後長度不得超過 maxSerializedLength（預設 100KB）。
 */
export async function computePayloadHash(
  payload: Record<string, unknown>,
  maxSerializedLength: number = 100_000
): Promise<string> {
  if (!isPlainObject(payload)) {
    throw new TypeError('computePayloadHash: payload must be a plain object');
  }
  const content = JSON.stringify(payload);
  if (content.length > maxSerializedLength) {
    throw new RangeError(
      `computePayloadHash: serialized payload length ${content.length} exceeds max ${maxSerializedLength}`
    );
  }
  return sha256Hash(content);
}

/** 合法 hash 為 64 字元 hex */
const HEX_64_REGEX = /^[0-9a-f]{64}$/;

/**
 * 驗證字串是否為 64 字元 hex（SHA-256 輸出格式）
 */
export function isHex64(s: unknown): s is string {
  return typeof s === 'string' && s.length === 64 && HEX_64_REGEX.test(s);
}

/**
 * 計算帳本條目的 entryHash（hash 鏈用）
 * entryHash = SHA256(previousHash + index + timestamp + payloadHash + creatorId)
 * previousHash 可為創世值（如 '0'），否則應為 64 字元 hex。
 */
export async function computeEntryHash(entry: {
  previousHash: string;
  index: number;
  timestamp: number;
  payloadHash: string;
  creatorId: string;
}): Promise<string> {
  if (typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) {
    throw new TypeError('computeEntryHash: index must be a non-negative integer');
  }
  if (typeof entry.timestamp !== 'number' || !Number.isInteger(entry.timestamp) || entry.timestamp < 0) {
    throw new TypeError('computeEntryHash: timestamp must be a non-negative integer');
  }
  if (typeof entry.creatorId !== 'string' || entry.creatorId.length === 0) {
    throw new TypeError('computeEntryHash: creatorId must be a non-empty string');
  }
  if (typeof entry.payloadHash !== 'string' || entry.payloadHash.length !== HASH_HEX_LENGTH) {
    throw new TypeError('computeEntryHash: payloadHash must be a 64-char hex string');
  }
  if (typeof entry.previousHash !== 'string') {
    throw new TypeError('computeEntryHash: previousHash must be a string');
  }
  const content = [
    entry.previousHash,
    String(entry.index),
    String(entry.timestamp),
    entry.payloadHash,
    entry.creatorId,
  ].join('|');
  return sha256Hash(content);
}
