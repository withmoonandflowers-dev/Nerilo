import ReactDOM from 'react-dom/client';
import App from './App';
import { autoStartMetricsExporter } from './core/metrics/MetricsExporter';
import { initSentry } from './config/sentry';
import { initAppCheck } from './config/appCheck';
import './index.css';

// No-op when VITE_SENTRY_DSN is unset.
initSentry();

// No-op when VITE_APPCHECK_KEY is unset（對外開放前才啟用；擋機器人濫用 Firebase）。
initAppCheck();

// No-op unless ?metrics=1 / localStorage['nerilo.metrics']='1' / window.__NERILO_METRICS__=true.
autoStartMetricsExporter();

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



