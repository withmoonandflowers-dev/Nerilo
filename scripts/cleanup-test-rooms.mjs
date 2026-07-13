#!/usr/bin/env node
/**
 * 清理 production 累積的測試遺留（讀取衛生，2026-07-13 配額事件）。
 *
 * 圈定方式：Auth 帳號 email 屬測試網域（@nerilo-smoke.test / @nerilo-e2e.test）
 * → 這些 uid 擁有的房間 = 測試遺留 → 遞迴刪除房間文件（含 signals/memberStates
 * 子集合），並刪除該批測試帳號本身。
 *
 * 執行（需要 Firebase Admin 權限，service account key 由你自己保管）：
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/cleanup-test-rooms.mjs          # dry-run（只列出）
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/cleanup-test-rooms.mjs --apply  # 真的刪
 *
 * 安全設計：預設 dry-run；只動測試網域帳號名下的資源，真實使用者不受影響。
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const TEST_EMAIL_RE = /@nerilo-(smoke|e2e)\.test$/i;

initializeApp({ credential: applicationDefault(), projectId: 'nerilo' });
const auth = getAuth();
const db = getFirestore();

// 1. 收集測試帳號 uid
const testUids = new Set();
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) {
    if (u.email && TEST_EMAIL_RE.test(u.email)) testUids.add(u.uid);
  }
  pageToken = page.pageToken;
} while (pageToken);
console.log(`測試帳號：${testUids.size} 個（email 符合 @nerilo-smoke.test / @nerilo-e2e.test）`);

// 2. 找這些帳號擁有的房間（分批 in 查詢，Firestore in 上限 30）
const uidList = [...testUids];
const roomRefs = [];
for (let i = 0; i < uidList.length; i += 30) {
  const chunk = uidList.slice(i, i + 30);
  const snap = await db.collection('p2pRooms').where('ownerUid', 'in', chunk).get();
  snap.forEach((d) => roomRefs.push(d.ref));
}
console.log(`測試遺留房間：${roomRefs.length} 間`);

if (!APPLY) {
  console.log('\n[dry-run] 未刪除任何東西。確認數字合理後加 --apply 執行。');
  process.exit(0);
}

// 3. 遞迴刪房（含 signals / memberStates 等子集合）
let deleted = 0;
for (const ref of roomRefs) {
  await db.recursiveDelete(ref);
  deleted++;
  if (deleted % 20 === 0) console.log(`  已刪 ${deleted}/${roomRefs.length} 間`);
}
console.log(`房間刪除完成：${deleted} 間`);

// 4. 刪測試帳號（分批，deleteUsers 上限 1000）
let removedUsers = 0;
for (let i = 0; i < uidList.length; i += 1000) {
  const chunk = uidList.slice(i, i + 1000);
  const res = await auth.deleteUsers(chunk);
  removedUsers += res.successCount;
}
console.log(`測試帳號刪除完成：${removedUsers} 個`);
console.log('\n完成。建議到 Firebase console 用量頁確認後續讀取量下降。');
