import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { logger } from './utils/logger';
import { initSentry } from './config/sentry';

// Initialize Sentry error tracking (no-op if VITE_SENTRY_DSN not set)
initSentry();

// Global unhandled error/rejection reporting
window.addEventListener('error', (event) => {
  logger.error('[Global] Unhandled error', { message: event.message, filename: event.filename, lineno: event.lineno });
});
window.addEventListener('unhandledrejection', (event) => {
  logger.error('[Global] Unhandled promise rejection', { reason: String(event.reason) });
});

/**
 * StrictMode 在開發模式下會 double-invoke effects（mount → unmount → re-mount），
 * 這與 WebRTC P2P 連線的外部資源生命週期不相容：
 * - RTCPeerConnection 無法在 unmount 時正確「暫停」再「恢復」
 * - Firestore signaling listeners 會產生重複訂閱
 * - DataChannel 的 open/close 狀態無法跨 mount cycle 保留
 *
 * 生產環境 StrictMode 無效果，不影響最終用戶。
 * 開發環境改用直接渲染，WebRTC 相關的 effect 正確性由單元測試和 E2E 測試保證。
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
);



