import React from 'react';
import type { ConnectionState } from '../../types';
import './ConnectionProgress.css';

interface ConnectionProgressProps {
  state: ConnectionState;
}

type StepStatus = 'done' | 'active' | 'pending';

/**
 * Onboarding Phase 2：連線進度視覺化。
 * 把不確定的轉圈動畫換成三步驟進度，讓使用者對「正在發生什麼」有掌握感，
 * 並降低「等待連線」這個最大流失點的焦慮。
 *
 * 步驟對應現有的 ConnectionState（不需 P2P 層提供更細的子狀態）：
 *   1. 加入房間      — connecting/connected 時皆已完成
 *   2. 建立 P2P 連線  — connecting 時進行中、connected 時完成
 *   3. 端對端加密就緒 — connected 時完成
 */
export const ConnectionProgress: React.FC<ConnectionProgressProps> = ({ state }) => {
  const connected = state === 'connected';

  const steps: { label: string; status: StepStatus }[] = [
    { label: '加入房間', status: 'done' },
    { label: '建立 P2P 連線', status: connected ? 'done' : 'active' },
    { label: '端對端加密就緒', status: connected ? 'done' : 'pending' },
  ];

  return (
    <div className="connection-progress" role="status" aria-live="polite" aria-label="連線進度">
      <ol className="connection-progress-steps">
        {steps.map((step) => (
          <li key={step.label} className={`connection-step ${step.status}`}>
            <span className="connection-step-marker" aria-hidden="true">
              {step.status === 'done' ? '✓' : step.status === 'active' ? '' : ''}
            </span>
            <span className="connection-step-label">{step.label}</span>
          </li>
        ))}
      </ol>
      <p className="connection-progress-hint">
        對方打開邀請連結後就會自動連上，通常只要幾秒
      </p>
    </div>
  );
};
