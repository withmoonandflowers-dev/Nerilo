/**
 * 加密狀態指示器（ADR-0004 決策 4／ADR-0026 R2／Spec 012 P4）。
 * 真值來源是服務的實際金鑰狀態，不是連線狀態；class 名保留原樣供 E2E 測試鉤
 * （golden-path／connection-states 用 -p2p/-fallback，mesh-diagnostic 用 -dtls）。
 */
import type { EncryptionState } from '../../types';

export type E2EEMode = 'p2p' | 'fallback' | 'exchanging' | 'mesh-dtls' | null;

/** mesh 房三態文案（Spec 012 P4 止血：依 getEncryptionState 真值，不再低報「非端到端」）。 */
const MESH_TEXT: Record<EncryptionState, { icon: string; label: string; aria: string; title: string }> = {
  encrypted: {
    icon: '🔒',
    label: '端到端加密',
    aria: '端到端加密已啟用（房間金鑰）',
    title: '房間內容以 AES-256-GCM 房間金鑰加密（keyx 分發），僅成員可解讀。詳見 docs/THREAT_MODEL.md。',
  },
  exchanging: {
    icon: '🔑',
    label: '金鑰交換中…',
    aria: '端到端加密金鑰交換中',
    title: '正在分發房間金鑰；完成前訊息暫緩送出，不會以明文傳送。',
  },
  plaintext: {
    icon: '⚠️',
    label: '未加密（暫停送出）',
    aria: '此房間未端到端加密',
    title: '此房間無法建立端到端加密（金鑰交換不可用或逾時）；訊息未加密即不送出。',
  },
};

export function E2EEIndicator({
  mode,
  meshState,
}: {
  mode: E2EEMode;
  meshState: EncryptionState | null;
}) {
  if (mode === 'p2p') {
    return (
      <span
        className="e2ee-indicator e2ee-indicator-p2p"
        role="status"
        aria-label="端到端加密已啟用"
        title="訊息以 AES-256-GCM 加密，僅房間成員可解讀。詳見 docs/THREAT_MODEL.md。"
      >
        <span aria-hidden="true">🔒</span> 端到端加密
      </span>
    );
  }
  if (mode === 'fallback') {
    return (
      <span
        className="e2ee-indicator e2ee-indicator-fallback"
        role="status"
        aria-label="備援模式：訊息仍以端到端金鑰加密，但透過伺服器中繼"
        title="P2P 未連線；訊息經由 Firestore 中繼，但內容仍以同一把 sender key 加密。"
      >
        <span aria-hidden="true">🔓</span> 備援模式（加密傳輸中）
      </span>
    );
  }
  if (mode === 'exchanging') {
    return (
      <span
        className="e2ee-indicator e2ee-indicator-exchanging"
        role="status"
        aria-label="端到端加密金鑰交換中"
        title="正在與對方交換加密金鑰；完成前訊息會暫緩送出，不會以明文傳送。"
      >
        <span aria-hidden="true">🔑</span> 金鑰交換中…
      </span>
    );
  }
  if (mode === 'mesh-dtls') {
    const t = MESH_TEXT[meshState ?? 'exchanging'];
    return (
      <span
        className="e2ee-indicator e2ee-indicator-dtls"
        role="status"
        aria-label={t.aria}
        title={t.title}
      >
        <span aria-hidden="true">{t.icon}</span> {t.label}
      </span>
    );
  }
  return null;
}
