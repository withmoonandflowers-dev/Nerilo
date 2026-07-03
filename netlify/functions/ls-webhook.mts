/**
 * Lemon Squeezy webhook → Firebase custom claims（ADR-0008）。
 *
 * 部署於 Netlify Functions（免費層），刻意不用 Cloud Functions——
 * 解除 M3 對 Blaze 方案的依賴（見 ADR-0008 附錄）。
 *
 * 環境變數（Netlify site settings 設定，皆為 secret）：
 * - LS_WEBHOOK_SECRET：LS webhook 簽章密鑰（建 webhook 時自訂）
 * - FIREBASE_SERVICE_ACCOUNT：Firebase service account JSON（單行字串）
 *
 * 授權真相源鏈：LS 訂閱事件 → 本函式驗簽 → custom claim plan=pro|free
 * → firestore.rules 讀 request.auth.token.plan 決定配額。前端只做顯示。
 */
import type { Context } from '@netlify/functions';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  verifySignature,
  resolvePlanChange,
  extractUid,
  extractEvent,
  type LsWebhookPayload,
} from './_lib/webhook-core';

function adminAuth() {
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getAuth();
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const secret = process.env.LS_WEBHOOK_SECRET ?? '';
  const rawBody = await req.text();
  const signature = req.headers.get('x-signature');

  if (!verifySignature(rawBody, signature, secret)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: LsWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  const { eventName, status } = extractEvent(payload);
  if (!eventName) return new Response('Missing event name', { status: 400 });

  const plan = resolvePlanChange(eventName, status);
  if (plan === null) {
    // 不影響方案的事件：確認收到即可
    return new Response('Ignored', { status: 200 });
  }

  const uid = extractUid(payload);
  if (!uid) {
    // 簽章有效但沒帶 uid（例如手動在 LS 後台建的測試訂單）：
    // 記錄並回 200，避免 LS 無限重送
    console.warn('[ls-webhook] Valid event without custom uid', { eventName });
    return new Response('No uid in custom data', { status: 200 });
  }

  try {
    const auth = adminAuth();
    const user = await auth.getUser(uid); // uid 不存在會 throw
    const existing = user.customClaims ?? {};
    await auth.setCustomUserClaims(uid, { ...existing, plan });
    console.log('[ls-webhook] Plan updated', { uid, plan, eventName });
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('[ls-webhook] Failed to set claim', { uid, plan, err: String(err) });
    // 5xx 讓 LS 重試（暫時性故障）；uid 不存在屬 4xx 不重試
    const notFound = String(err).includes('no user record');
    return new Response('Claim update failed', { status: notFound ? 400 : 500 });
  }
};

export const config = {
  path: '/api/ls-webhook',
};
