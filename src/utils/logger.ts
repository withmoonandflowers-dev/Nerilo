/**
 * 環境感知 Logger
 *
 * - 開發環境（DEV）：所有層級均輸出
 * - 正式環境（PROD）：僅 warn / error 輸出；debug / info 靜默
 * - 敏感欄位過濾：自動遮罩 claims、token、password 等欄位
 *
 * 使用方式：
 *   import { logger } from '@/utils/logger';
 *   logger.debug('[P2PManager] initialized', { roomId });
 *   logger.info('[RoomService] joined', { roomId, uid });
 *   logger.warn('[Auth] token expired');
 *   logger.error('[Chat] send failed', error);
 */

const IS_DEV = import.meta.env.DEV;

/** 需要遮罩的欄位名稱（不分大小寫） */
const SENSITIVE_KEYS = new Set([
  'claims', 'customclaims', 'token', 'idtoken', 'accesstoken',
  'password', 'secret', 'credential', 'apikey', 'api_key',
]);

/**
 * 遞迴遮罩物件中的敏感欄位
 * 僅在正式環境啟用（開發環境為了除錯方便，保留完整資料）
 */
function sanitize(data: unknown, depth = 0): unknown {
  if (IS_DEV || depth > 5) return data;
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitize(value, depth + 1);
    }
  }
  return result;
}

function noop(): void { /* silent */ }

export const logger = {
  /** 開發環境才輸出；正式環境靜默 */
  debug: IS_DEV
    ? (message: string, ...args: unknown[]) =>
        console.debug(message, ...args.map((a) => sanitize(a)))
    : noop,

  /** 開發環境才輸出；正式環境靜默 */
  info: IS_DEV
    ? (message: string, ...args: unknown[]) =>
        console.log(message, ...args.map((a) => sanitize(a)))
    : noop,

  /** 任何環境都輸出（遮罩敏感資料） */
  warn: (message: string, ...args: unknown[]) =>
    console.warn(message, ...args.map((a) => sanitize(a))),

  /** 任何環境都輸出（遮罩敏感資料） */
  error: (message: string, ...args: unknown[]) =>
    console.error(message, ...args.map((a) => sanitize(a))),
};
