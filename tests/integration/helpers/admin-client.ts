/**
 * Firebase Admin SDK 測試用戶端
 *
 * Admin SDK 繞過 Firestore 安全規則，用於：
 *  - 測試前置資料 (seed)
 *  - 測試後清理 (cleanup)
 *  - 建立測試用帳號與自訂 Token
 *
 * 業界做法：測試中只有 admin 可以直接寫資料庫；
 * 驗證安全規則時，改用 web SDK（見 web-client.ts）。
 */
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// firebase-admin 僅有 CJS export，以 createRequire 匯入
const admin = _require('firebase-admin') as typeof import('firebase-admin');

const TEST_PROJECT_ID = 'nerilo';

// 避免重複初始化（vitest 同 process 內多次 import 時）
let _adminApp: ReturnType<typeof admin.initializeApp> | null = null;

function getAdminApp() {
  if (_adminApp) return _adminApp;
  _adminApp = admin.initializeApp(
    { projectId: TEST_PROJECT_ID },
    `test-admin-${Date.now()}`
  );
  return _adminApp;
}

export function adminDb() {
  return getAdminApp().firestore();
}

export function adminAuth() {
  return getAdminApp().auth();
}

/**
 * 清空 Firestore Emulator 中的所有資料
 * 業界慣例：每個 describe 前後清空，確保測試隔離
 */
export async function clearEmulatorData(): Promise<void> {
  const projectId = TEST_PROJECT_ID;
  // Emulator REST API：DELETE 清空所有文件
  const url = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok && res.status !== 200) {
    const text = await res.text();
    throw new Error(`clearEmulatorData failed: ${res.status} ${text}`);
  }
}

/**
 * 建立測試用 Email/Password 帳號並回傳 custom token
 * （非匿名帳號，sign_in_provider = "custom"）
 */
export async function createTestUser(
  uid: string,
  claims: Record<string, unknown> = {}
): Promise<string> {
  const auth = adminAuth();
  try {
    await auth.createUser({ uid });
  } catch {
    // 帳號已存在時略過（deleteUser 清理可能有延遲）
  }
  if (Object.keys(claims).length > 0) {
    await auth.setCustomUserClaims(uid, claims);
  }
  return auth.createCustomToken(uid, claims);
}

/**
 * 刪除測試用帳號
 */
export async function deleteTestUser(uid: string): Promise<void> {
  try {
    await adminAuth().deleteUser(uid);
  } catch {
    // 不存在時略過
  }
}

export { TEST_PROJECT_ID };
