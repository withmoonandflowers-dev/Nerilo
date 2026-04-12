/**
 * Sentry Error Tracking Configuration
 *
 * 設定方式：
 * 1. 在 https://sentry.io 建立專案（選擇 React platform）
 * 2. 將 DSN 加到 .env.local: VITE_SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
 * 3. 部署後即可在 Sentry dashboard 看到錯誤報告
 */

import * as Sentry from '@sentry/react';

const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN;

export function initSentry(): void {
  if (!SENTRY_DSN) {
    // DSN 未設定時靜默跳過（開發環境）
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    // 只在 production 啟用效能追蹤
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
    // 過濾掉開發環境的雜訊
    beforeSend(event) {
      // 不送出 localhost 的錯誤
      if (window.location.hostname === 'localhost') return null;
      return event;
    },
    // 整合
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    // Session Replay 取樣率（隱私優先，只在錯誤時錄製）
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: import.meta.env.PROD ? 0.5 : 0,
  });
}

/** 手動捕獲錯誤（用於 catch block 中非 unhandled 的錯誤） */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!SENTRY_DSN) return;
  Sentry.captureException(error, { extra: context });
}
