import React from 'react';
import { logger } from '../utils/logger';

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logger.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', padding: '24px', textAlign: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '12px', color: '#333' }}>
            發生錯誤
          </h1>
          <p style={{ color: '#666', marginBottom: '24px', maxWidth: '400px' }}>
            應用程式遇到未預期的問題。請嘗試重新整理頁面。
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={this.handleReset}
              style={{
                padding: '10px 24px', borderRadius: '6px', border: 'none',
                background: '#667eea', color: '#fff', cursor: 'pointer', fontSize: '14px',
              }}
            >
              重試
            </button>
            <button
              onClick={() => window.location.href = '/dashboard'}
              style={{
                padding: '10px 24px', borderRadius: '6px', border: '1px solid #ddd',
                background: '#fff', color: '#333', cursor: 'pointer', fontSize: '14px',
              }}
            >
              返回首頁
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
