#!/usr/bin/env node
/**
 * 手動發放/收回 Pro plan claim（LS webhook 之外的第二條發放路徑）。
 *
 * 用途：不走 Lemon Squeezy 的成交（匯款、贈送、測試帳號）。與 webhook 寫入
 * 完全同語義（merge 既有 claims、只動 plan 欄位）；firestore.rules 讀
 * request.auth.token.plan，唯一真相源在 Auth custom claims。
 *
 * 用法（需要 Firebase 專案擁有者的 service account 憑證）：
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *     node scripts/grant-plan.mjs <uid 或 email> <pro|free>
 *   或把 service account JSON 整份放進 FIREBASE_SERVICE_ACCOUNT 環境變數。
 *
 * 注意：claim 寫入後，使用者既有 ID token 最長 1 小時才自然輪替；
 * 兩線前端都有 focus 強制刷新，或請使用者重新登入即可立即生效。
 */
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [, , identifier, planArg] = process.argv;

if (!identifier || !['pro', 'free'].includes(planArg)) {
  console.error('用法：node scripts/grant-plan.mjs <uid 或 email> <pro|free>');
  process.exit(1);
}

const credential = process.env.FIREBASE_SERVICE_ACCOUNT
  ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  : applicationDefault();

initializeApp({ credential });
const auth = getAuth();

const user = identifier.includes('@')
  ? await auth.getUserByEmail(identifier)
  : await auth.getUser(identifier);

const existing = user.customClaims ?? {};
const before = existing.plan ?? 'free';

if (before === planArg) {
  console.log(`無事可做：${user.uid}（${user.email ?? '無 email'}）已是 plan=${planArg}`);
  process.exit(0);
}

await auth.setCustomUserClaims(user.uid, { ...existing, plan: planArg });
console.log(`已更新 ${user.uid}（${user.email ?? '無 email'}）：plan ${before} → ${planArg}`);
console.log('提醒：使用者的 ID token 最長 1 小時後生效；重新登入或前端 focus 刷新可立即生效。');
