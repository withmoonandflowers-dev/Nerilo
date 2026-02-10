import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

// 注意：實際部署時應使用環境變數；
// 若環境變數缺失或為佔位符，退回到專案 nerilo 的正式設定，避免出現 api-key-not-valid 錯誤
const isPlaceholder = (value: string | undefined): boolean => {
  if (!value) return true;
  const placeholders = ['your-api-key', 'your-project', 'your-project-id', 'your-app-id'];
  return placeholders.some(placeholder => value.includes(placeholder));
};

const firebaseConfig = {
  apiKey:
    (import.meta.env.VITE_FIREBASE_API_KEY && !isPlaceholder(import.meta.env.VITE_FIREBASE_API_KEY))
      ? import.meta.env.VITE_FIREBASE_API_KEY
      : 'AIzaSyB3JwZFuRYHYkRReoYW94cfJGXDr6B9msY',
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



