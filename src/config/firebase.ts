import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

// 資安：正式環境應僅使用環境變數，勿依賴 fallback。CI/正式 build 請注入 VITE_FIREBASE_*。
// 以下 fallback 僅供開發/展示；若環境變數缺失或為佔位符，退回到專案預設以避免 api-key-not-valid。
const isPlaceholder = (value: string | undefined): boolean => {
  if (!value) return true;
  const placeholders = ['your-api-key', 'your-project', 'your-project-id', 'your-app-id'];
  return placeholders.some(placeholder => value.includes(placeholder));
};

const firebaseConfig = {
  apiKey:
    (import.meta.env.VITE_FIREBASE_API_KEY && !isPlaceholder(import.meta.env.VITE_FIREBASE_API_KEY))
      ? import.meta.env.VITE_FIREBASE_API_KEY
      : 'AIzaSy_REDACTED_ROTATED_KEY',
  authDomain:
    (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN && !isPlaceholder(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN))
      ? import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
      : 'nerilo.firebaseapp.com',
  projectId:
    (import.meta.env.VITE_FIREBASE_PROJECT_ID && !isPlaceholder(import.meta.env.VITE_FIREBASE_PROJECT_ID))
      ? import.meta.env.VITE_FIREBASE_PROJECT_ID
      : 'nerilo',
  storageBucket:
    (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET && !isPlaceholder(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET))
      ? import.meta.env.VITE_FIREBASE_STORAGE_BUCKET
      : 'nerilo.firebasestorage.app',
  messagingSenderId:
    (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID && !isPlaceholder(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID))
      ? import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID
      : '367602787660',
  appId:
    (import.meta.env.VITE_FIREBASE_APP_ID && !isPlaceholder(import.meta.env.VITE_FIREBASE_APP_ID))
      ? import.meta.env.VITE_FIREBASE_APP_ID
      : '1:367602787660:web:b2078171fb068d39099be9',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

export default app;



