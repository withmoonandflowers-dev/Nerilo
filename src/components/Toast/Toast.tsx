import React, { useEffect, useState } from 'react';
import './Toast.css';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
}

const ICONS: Record<ToastType, string> = {
  success: '\u2705',
  error: '\u274C',
  warning: '\u26A0\uFE0F',
  info: '\u2139\uFE0F',
};

interface ToastProps {
  toast: ToastItem;
  onRemove: (id: string) => void;
}

const ToastSingle: React.FC<ToastProps> = ({ toast, onRemove }) => {
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setRemoving(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (removing) {
      const timer = setTimeout(() => onRemove(toast.id), 250);
      return () => clearTimeout(timer);
    }
  }, [removing, toast.id, onRemove]);

  const handleClose = () => {
    setRemoving(true);
  };

  return (
    <div className={`toast ${toast.type}${removing ? ' removing' : ''}`} role="alert">
      <span className="toast-icon" aria-hidden="true">{ICONS[toast.type]}</span>
      <div className="toast-body">
        <span className="toast-message">{toast.message}</span>
      </div>
      <button className="toast-close" onClick={handleClose} aria-label="關閉通知">&times;</button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: ToastItem[];
  onRemove: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemove }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-label="通知區域">
      {toasts.map((t) => (
        <ToastSingle key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
};
