import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, initializeFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { logger } from '../utils/logger';
// firebase/functions 已移除 — 目前未使用 Cloud Functions（ICE servers 改用直連 STUN）
// 未來若需要 httpsCallable()，再 import { getFunctions } from 'firebase/functions'

/**
 * Firebase 設定
 *
 * 所有值均從環境變數讀取（Vite 透過 import.meta.env 注入）。
 * - 本機開發：在專案根目錄建立 `.env.local`，填入 VITE_FIREBASE_* 變數
 * - CI / 正式部署：注入對應環境變數
 * - test mode（`vite --mode test`）：自動連接 Firebase Emulator
 *
 * 若任何必要變數缺失，在開發模式下會輸出警告；
 * 正式環境則直接使用空字串（Firebase SDK 會在初始化時拋出更明確的錯誤）。
 */

// test 判定兩用：vite `--mode test`（React E2E 既有路徑），或顯式
// `VITE_USE_EMULATOR=true`（nuxt/web-vue 的 dev server 無法自訂 vite mode，
// Vue 版 E2E 走此開關）。兩者行為完全相同：假 config + 連本機 emulator。
const IS_TEST_MODE =
  import.meta.env.MODE === 'test' || import.meta.env.VITE_USE_EMULATOR === 'true';
const IS_DEV = import.meta.env.DEV;

const REQUIRED_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

// Test mode 使用假的 config 連 emulator（不需要真實 API key）
const firebaseConfig = IS_TEST_MODE
  ? {
      apiKey: 'fake-api-key-for-emulator',
      authDomain: 'localhost',
      projectId: 'nerilo',
      storageBucket: '',
      messagingSenderId: '000000000000',
      appId: '1:000000000000:web:0000000000000000',
    }
  : {
      apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            ?? '',
      authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        ?? '',
      projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         ?? '',
      storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     ?? '',
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
      appId:             import.meta.env.VITE_FIREBASE_APP_ID             ?? '',
    };

// 開發模式（非 test）下檢查環境變數是否齊全
if (IS_DEV && !IS_TEST_MODE) {
  const missing = REQUIRED_VARS.filter(
    (key) => !import.meta.env[key] || import.meta.env[key] === `your-${key.toLowerCase()}`
  );
  if (missing.length > 0) {
    logger.warn(
      `[Firebase] 缺少環境變數，請確認 .env.local 已正確設定：\n  ${missing.join('\n  ')}\n` +
      `可參考 .env.local.example 範本。`
    );
  }
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Test mode 強制 long-polling：Firestore WebChannel 在自動化瀏覽器（Playwright）
// 下已知會斷流（'transport errored' → client 轉 offline、收不到 onSnapshot），
// 多 context E2E 尤其明顯。僅測試模式生效，production 行為不變。
export const db = IS_TEST_MODE
  ? initializeFirestore(app, { experimentalForceLongPolling: true })
  : getFirestore(app);

// Test mode：自動連接 Firebase Emulator（E2E 測試用）
if (IS_TEST_MODE) {
  try {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    logger.info('[Firebase] Connected to emulators (test mode)');
  } catch (err) {
    logger.warn('[Firebase] Failed to connect to emulators', err);
  }
  // Expose to window for Playwright E2E security tests that need to make
  // direct Firestore calls (e.g. verify a non-participant can't read a
  // room, or that fallback messages are encrypted). Test mode only.
  // The firestore SDK module is exposed too: bare specifiers like
  // `import('firebase/firestore')` don't resolve inside page.evaluate
  // (no import map in the browser), so tests must take it from here.
  if (typeof window !== 'undefined') {
    const testExports: Record<string, unknown> = { app, auth, db };
    (window as unknown as { __nerilo_test__?: unknown }).__nerilo_test__ = testExports;
    import('firebase/firestore').then((m) => {
      testExports.firestore = m;
    });
  }
}

export default app;
