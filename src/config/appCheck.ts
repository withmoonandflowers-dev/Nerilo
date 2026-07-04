/**
 * Firebase App Check — 擋機器人/腳本濫用（威脅模型 F1 正解）
 *
 * 作用：確保打到 Firestore/Functions 的請求來自「真的 Nerilo App 實例」，
 * 而非腳本。保護唯一的中央成本點（Firebase：signaling / fallback / rooms）
 * 不被自動化灌爆——對真實使用者零摩擦（reCAPTCHA v3 背景 attestation）。
 *
 * 設定（需使用者在 Firebase console 動作，非程式）：
 *   1. console → App Check → 註冊 reCAPTCHA v3（web app），取得 site key。
 *   2. 部署環境設 VITE_APPCHECK_KEY = 該 site key。
 *   3. console → App Check → 對 Firestore / Functions 開 Enforce。
 *
 * 未設 VITE_APPCHECK_KEY 時 initAppCheck() 為 no-op（本機/私用免設定，
 * 與 Sentry 同模式）。對外開放前才需啟用。
 *
 * 刻意獨立於 config/firebase.ts：該檔案由平行工作維護中，此模組只 import
 * 既有 app 實例，零侵入，從 main.tsx 呼叫。
 */

import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import app from './firebase';
import { logger } from '../utils/logger';

const APPCHECK_KEY = import.meta.env?.VITE_APPCHECK_KEY as string | undefined;

let initialized = false;

export function initAppCheck(): void {
  if (initialized) return;
  if (!APPCHECK_KEY) return; // 無 key → no-op（開發/私用）
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APPCHECK_KEY),
      // 自動換發 token，長時間開著的分頁不會過期被拒
      isTokenAutoRefreshEnabled: true,
    });
    initialized = true;
    logger.info('[appCheck] initialized');
  } catch (err) {
    // App Check init 失敗不得中斷 App 啟動（degrade：請求可能被 enforce 擋，
    // 但至少不白屏）。記錄供除錯。
    logger.warn('[appCheck] init failed', { err });
  }
}

/** 是否已啟用（供除錯/測試） */
export function isAppCheckEnabled(): boolean {
  return initialized;
}
