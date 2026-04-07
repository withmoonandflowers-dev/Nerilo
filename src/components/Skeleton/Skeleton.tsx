import React from 'react';
import './Skeleton.css';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: 'text' | 'title' | 'circle' | 'button' | 'rect';
  className?: string;
}

/** Generic skeleton block */
export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  variant = 'rect',
  className = '',
}) => {
  const style: React.CSSProperties = {};
  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  return <div className={`skeleton ${variant} ${className}`} style={style} aria-hidden="true" />;
};

/** Skeleton for a room card row (used in DashboardPage) */
export const SkeletonRoomCard: React.FC = () => (
  <div className="skeleton-room-card" aria-hidden="true">
    <div className="skeleton-room-info">
      <Skeleton variant="title" width="50%" />
      <Skeleton variant="text" width="70%" />
    </div>
    <Skeleton variant="button" width={64} />
  </div>
);

/** Skeleton for a feature card (used in DashboardPage) */
export const SkeletonFeatureCard: React.FC = () => (
  <div className="skeleton-feature-card" aria-hidden="true">
    <Skeleton variant="circle" width={40} height={40} />
    <Skeleton variant="title" width="70%" />
    <Skeleton variant="text" width="100%" />
    <Skeleton variant="text" width="85%" />
  </div>
);

/** Skeleton for chat message bubbles (used in ChatPage) */
export const SkeletonMessages: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '24px' }} aria-hidden="true">
    <div className="skeleton-message other">
      <Skeleton className="skeleton-message-bubble" width="65%" height={48} />
      <Skeleton variant="text" width={50} height={10} />
    </div>
    <div className="skeleton-message own">
      <Skeleton className="skeleton-message-bubble" width="55%" height={36} />
      <Skeleton variant="text" width={50} height={10} />
    </div>
    <div className="skeleton-message other">
      <Skeleton className="skeleton-message-bubble" width="75%" height={60} />
      <Skeleton variant="text" width={50} height={10} />
    </div>
  </div>
);

/** Connecting animation with bouncing dots */
export const ConnectingAnimation: React.FC<{ text?: string }> = ({ text = '正在建立連線...' }) => (
  <div className="skeleton-connecting">
    <div className="connecting-dots">
      <span />
      <span />
      <span />
    </div>
    <p>{text}</p>
  </div>
);

/** App-level loading fallback (replaces plain text) */
export const AppLoadingFallback: React.FC = () => (
  <div className="app-loading-fallback">
    <div className="app-loading-logo">Nerilo</div>
    <div className="app-loading-bar" />
  </div>
);
