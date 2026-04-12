import React, { useState, useEffect, useRef } from 'react';
import type { ConnectionState } from '../../types';
import './ConnectionBanner.css';

interface ConnectionBannerProps {
  connectionState: ConnectionState;
  /** 'p2p_star' | 'p2p_mesh' | 'firestore' | null */
  mode?: string | null;
  onReconnect?: () => void;
}

const STATE_CONFIG: Record<string, { icon: string; label: string }> = {
  connected: { icon: '\uD83D\uDFE2', label: 'P2P 已連線' },
  connecting: { icon: '\uD83D\uDFE1', label: '連線中' },
  failed: { icon: '\uD83D\uDD34', label: '連線失敗' },
  closed: { icon: '\uD83D\uDD34', label: '已斷線' },
  idle: { icon: '\u26AA', label: '準備連線' },
};

const MODE_LABELS: Record<string, string> = {
  p2p_star: 'P2P 直連',
  p2p_mesh: 'Mesh 中繼',
  firestore: 'Firestore 備援',
};

export const ConnectionBanner: React.FC<ConnectionBannerProps> = ({
  connectionState,
  mode,
  onReconnect,
}) => {
  const [reconnectCountdown, setReconnectCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start countdown when failed/closed
  useEffect(() => {
    if (connectionState === 'failed' || connectionState === 'closed') {
      setReconnectCountdown(30);
      countdownRef.current = setInterval(() => {
        setReconnectCountdown((prev) => {
          if (prev === null || prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            return null;
          }
          return prev - 1;
        });
      }, 1000);
      return () => {
        if (countdownRef.current) clearInterval(countdownRef.current);
      };
    } else {
      setReconnectCountdown(null);
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    }
  }, [connectionState]);

  const isFallback = connectionState !== 'connected' && mode === 'firestore';
  const bannerClass = isFallback ? 'fallback' : connectionState;
  const config = isFallback
    ? { icon: '\u26A0\uFE0F', label: '備援模式 — 訊息經由伺服器中繼，端對端加密未啟用' }
    : (STATE_CONFIG[connectionState] || STATE_CONFIG.idle);

  const modeLabel = mode ? MODE_LABELS[mode] || mode : null;
  const showReconnect = (connectionState === 'failed' || connectionState === 'closed') && onReconnect;

  // Don't render when idle (not yet initialized)
  if (connectionState === 'idle') return null;

  return (
    <div
      className={`connection-banner ${bannerClass}${connectionState === 'connected' ? ' auto-hide' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`連線狀態：${config.label}`}
    >
      <span className="connection-banner-icon" aria-hidden="true">{config.icon}</span>
      <span className="connection-banner-text">
        {config.label}
        {modeLabel && connectionState === 'connected' && ` — ${modeLabel}`}
      </span>
      {showReconnect && (
        <span className="connection-banner-extra">
          {reconnectCountdown !== null && (
            <span>{reconnectCountdown}s 後自動重連</span>
          )}
          <button className="btn-reconnect" onClick={onReconnect}>
            手動重連
          </button>
        </span>
      )}
    </div>
  );
};

/** Simplified indicator for WaitingRoom */
interface ConnectionIndicatorProps {
  participantCount: number;
}

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({ participantCount }) => {
  const isReady = participantCount >= 2;
  return (
    <span
      className={`connection-indicator ${isReady ? 'ready' : 'waiting'}`}
      role="status"
      aria-label={isReady ? '已有足夠人數，可以開始' : '等待其他人加入'}
    >
      {isReady ? '\uD83D\uDFE2' : '\uD83D\uDFE1'} {isReady ? '就緒' : '等待中'}
    </span>
  );
};
