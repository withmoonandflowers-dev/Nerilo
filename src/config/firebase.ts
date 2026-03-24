import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

/**
 * Firebase 設定
 *
 * 所有值均從環境變數讀取（Vite 透過 import.meta.env 注入）。
 * - 本機開發：在專案根目錄建立 `.env.local`，填入 VITE_FIREBASE_* 變數
 * - CI / 正式部署：注入對應環境變數
 *
 * 若任何必要變數缺失，在開發模式下會輸出警告；
 * 正式環境則直接使用空字串（Firebase SDK 會在初始化時拋出更明確的錯誤）。
 */

const REQUIRED_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

// 開發模式下檢查環境變數是否齊全
if (import.meta.env.DEV) {
  const missing = REQUIRED_VARS.filter(
    (key) => !import.meta.env[key] || import.meta.env[key] === `your-${key.toLowerCase()}`
  );
  if (missing.length > 0) {
    console.warn(
      `[Firebase] 缺少環境變數，請確認 .env.local 已正確設定：\n  ${missing.join('\n  ')}\n` +
      `可參考 .env.local.example 範本。`
    );
  }
}

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            ?? '',
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        ?? '',
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         ?? '',
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId:             import.meta.env.VITE_FIREBASE_APP_ID             ?? '',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

export default app;
