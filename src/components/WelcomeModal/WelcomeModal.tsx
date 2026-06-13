import React, { useEffect } from 'react';
import './WelcomeModal.css';

interface WelcomeModalProps {
  isOpen: boolean;
  /** 主行動：建立第一個房間（option A — 引導登入流程在呼叫端決定） */
  onCreateRoom: () => void;
  /** 次行動：我有邀請連結 */
  onHaveInvite: () => void;
  /** 關閉（「之後再說」或遮罩/Esc） */
  onClose: () => void;
}

/**
 * 首次造訪歡迎彈窗 — onboarding 第一階段「落地與認識」。
 * 顯示時機由呼叫端以 localStorage flag 控制；本元件只負責呈現與行動分派。
 */
export const WelcomeModal: React.FC<WelcomeModalProps> = ({
  isOpen,
  onCreateRoom,
  onHaveInvite,
  onClose,
}) => {
  // Esc 關閉
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="welcome-modal-overlay"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-modal-title"
    >
      <div className="welcome-modal">
        <h2 id="welcome-modal-title" className="welcome-modal-title">Nerilo</h2>
        <p className="welcome-modal-subtitle">端對端加密的 P2P 聊天，不經伺服器</p>

        <ul className="welcome-value-props">
          <li>
            <span className="welcome-value-icon" aria-hidden="true">🔒</span>
            <span>訊息加密，連我們也看不到</span>
          </li>
          <li>
            <span className="welcome-value-icon" aria-hidden="true">⚡</span>
            <span>點對點直連，速度快</span>
          </li>
          <li>
            <span className="welcome-value-icon" aria-hidden="true">📲</span>
            <span>免下載，開連結就能用</span>
          </li>
        </ul>

        <button className="welcome-btn-primary" onClick={onCreateRoom}>
          建立第一個房間
        </button>
        <button className="welcome-btn-secondary" onClick={onHaveInvite}>
          我有邀請連結
        </button>
        <button className="welcome-btn-dismiss" onClick={onClose}>
          之後再說
        </button>
      </div>
    </div>
  );
};
