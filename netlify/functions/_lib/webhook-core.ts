/**
 * Lemon Squeezy webhook 純邏輯（ADR-0008）。
 *
 * 與 Netlify runtime 解耦以便單元測試：簽章驗證、事件到方案的映射、
 * uid 提取都在這裡；handler（ls-webhook.mts）只做 IO 與 firebase-admin。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Plan = 'free' | 'pro';

/**
 * 驗證 X-Signature（HMAC-SHA256 hex digest of raw body）。
 * timing-safe 比較，長度不符直接拒絕。
 */
export function verifySignature(
  rawBody: string,
  signatureHex: string | null,
  secret: string
): boolean {
  if (!signatureHex || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 事件 → 方案變更。回傳 null 表示此事件不影響方案（忽略即可）。
 *
 * 映射原則：
 * - created / resumed / unpaused / updated(active|on_trial|past_due) → pro
 *   （past_due 保留權益：LS 會自動催收，真正終止時送 expired）
 * - expired → free（cancelled 只是「將於期末終止」，期末 LS 會送 expired，
 *   在那之前訂閱者仍應享有已付費期間的權益）
 */
export function resolvePlanChange(
  eventName: string,
  subscriptionStatus?: string
): Plan | null {
  switch (eventName) {
    case 'subscription_created':
    case 'subscription_resumed':
    case 'subscription_unpaused':
      return 'pro';
    case 'subscription_updated': {
      if (!subscriptionStatus) return null;
      if (['active', 'on_trial', 'past_due'].includes(subscriptionStatus)) return 'pro';
      if (['expired'].includes(subscriptionStatus)) return 'free';
      return null; // cancelled/paused 等：期末由 expired 收尾
    }
    case 'subscription_expired':
      return 'free';
    default:
      return null;
  }
}

export interface LsWebhookPayload {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, unknown>;
  };
  data?: {
    attributes?: {
      status?: string;
    };
  };
}

/** 從 checkout 帶入的 custom_data 取 Firebase uid（無或格式不符回 null） */
export function extractUid(payload: LsWebhookPayload): string | null {
  const uid = payload.meta?.custom_data?.uid;
  if (typeof uid !== 'string') return null;
  // Firebase uid 為 1-128 字元；擋掉明顯異常輸入
  if (uid.length < 1 || uid.length > 128) return null;
  return uid;
}

export function extractEvent(payload: LsWebhookPayload): {
  eventName: string | null;
  status: string | undefined;
} {
  return {
    eventName: payload.meta?.event_name ?? null,
    status: payload.data?.attributes?.status,
  };
}
