/**
 * Firebase Web SDK 測試用戶端
 *
 * Web SDK 受 Firestore 安全規則約束，用於：
 *  - 測試一般使用者的讀寫權限
 *  - 驗證安全規則是否正確拒絕未授權操作
 *
 * 業界做法：用不同 uid 的 client 模擬不同身分，
 * 並測試預期的 PERMISSION_DENIED 行為。
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';
import {
  getAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signInAnonymously,
  signOut,
  type Auth,
} from 'firebase/auth';

const TEST_PROJECT_ID = 'nerilo';
// Firebase Web SDK 要求 apiKey 存在且格式正確（即使連 Emulator 也不例外）
// Emulator 不驗證 key 的有效性，所以用一個假的即可
const TEST_API_KEY = 'AIzaSyFakeKeyForEmulatorTesting123456';

interface TestClient {
  app: FirebaseApp;
  db: Firestore;
  auth: Auth;
  uid: string | null;
}

const _clients = new Map<string, TestClient>();

/**
 * 取得（或建立）一個具名 Web SDK client
 * 每個 client 有獨立的 FirebaseApp，模擬不同使用者
 */
function getClient(name: string): TestClient {
  if (_clients.has(name)) return _clients.get(name)!;

  const app = initializeApp({ projectId: TEST_PROJECT_ID, apiKey: TEST_API_KEY }, `test-web-${name}`);
  const db = getFirestore(app);
  const auth = getAuth(app);

  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

  const client: TestClient = { app, db, auth, uid: null };
  _clients.set(name, client);
  return client;
}

/**
 * 以自訂 token（非匿名）登入
 */
export async function signInWithToken(
  clientName: string,
  customToken: string
): Promise<{ db: Firestore; uid: string }> {
  const client = getClient(clientName);
  const cred = await signInWithCustomToken(client.auth, customToken);
  client.uid = cred.user.uid;
  return { db: client.db, uid: cred.user.uid };
}

/**
 * 以匿名身分登入（sign_in_provider = "anonymous"）
 */
export async function signInAnon(
  clientName: string
): Promise<{ db: Firestore; uid: string }> {
  const client = getClient(clientName);
  const cred = await signInAnonymously(client.auth);
  client.uid = cred.user.uid;
  return { db: client.db, uid: cred.user.uid };
}

/**
 * 登出
 */
export async function signOutClient(clientName: string): Promise<void> {
  const client = _clients.get(clientName);
  if (client) await signOut(client.auth);
}

/**
 * 取得未登入的 db（用於測試 unauthenticated 規則）
 */
export function unauthDb(clientName = 'unauth'): Firestore {
  return getClient(clientName).db;
}

/**
 * 清理所有 Web SDK app（測試結束後呼叫）
 */
export async function cleanupWebClients(): Promise<void> {
  const promises = Array.from(_clients.values()).map(c => deleteApp(c.app).catch(() => {}));
  await Promise.all(promises);
  _clients.clear();
}
