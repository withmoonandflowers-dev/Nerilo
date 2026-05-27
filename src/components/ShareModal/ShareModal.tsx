import React, { useEffect, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { useToast } from '../../contexts/ToastContext';
import { logger } from '../../utils/logger';
import './ShareModal.css';

interface ShareModalProps {
  roomId: string;
  roomName?: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ roomId, roomName, isOpen, onClose }) => {
  const toast = useToast();
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const supportsShare = typeof navigator !== 'undefined' && !!navigator.share;

  const shareUrl = `${window.location.origin}/chat/${roomId}`;
  const shareTitle = roomName ? `加入 ${roomName} — Nerilo` : `加入 Nerilo 聊天室`;

  // Generate QR code
  useEffect(() => {
    if (isOpen && qrCanvasRef.current) {
      QRCode.toCanvas(qrCanvasRef.current, shareUrl, {
        width: 180,
        margin: 2,
        color: { dark: '#333333', light: '#ffffff' },
      }).catch((err: Error) => logger.error('[ShareModal] QR generation failed', err));
    }
  }, [isOpen, shareUrl]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      toast.success('連結已複製到剪貼簿！');
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback
      if (inputRef.current) {
        inputRef.current.select();
        document.execCommand('copy');
        setCopied(true);
        toast.success('連結已複製到剪貼簿！');
        setTimeout(() => setCopied(false), 2000);
      }
    });
  }, [shareUrl, toast]);

  const handleNativeShare = useCallback(async () => {
    try {
      await navigator.share({
        title: shareTitle,
        text: `一起聊天吧！加入 Nerilo 房間：`,
        url: shareUrl,
      });
    } catch (err) {
      // User cancelled or share failed — ignore AbortError
      if (err instanceof Error && err.name !== 'AbortError') {
        logger.error('[ShareModal] Share failed', err);
      }
    }
  }, [shareTitle, shareUrl]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="share-modal-overlay" onClick={handleOverlayClick} role="dialog" aria-modal="true" aria-label="分享房間">
      <div className="share-modal">
        <div className="share-modal-header">
          <h3>分享房間</h3>
          <button className="share-modal-close" onClick={onClose} aria-label="關閉">
            &times;
          </button>
        </div>

        <div className="share-modal-body">
          {/* Copy link */}
          <div className="share-link-section">
            <label>房間連結</label>
            <div className="share-link-row">
              <input
                ref={inputRef}
                className="share-link-input"
                type="text"
                value={shareUrl}
                readOnly
                onFocus={(e) => e.target.select()}
              />
              <button className={`btn-copy${copied ? ' copied' : ''}`} onClick={handleCopy}>
                {copied ? '已複製 ✓' : '複製連結'}
              </button>
            </div>
          </div>

          <div className="share-divider" />

          {/* QR Code */}
          <div className="share-qr-section">
            <canvas ref={qrCanvasRef} />
            <span className="share-qr-label">掃描 QR Code 加入房間</span>
          </div>

          {/* Native share */}
          {supportsShare && (
            <>
              <div className="share-divider" />
              <div className="share-actions">
                <button className="btn-share-native" onClick={handleNativeShare}>
                  <span aria-hidden="true">&#x1F4E4;</span> 更多分享方式
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
