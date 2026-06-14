import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { featureLog } from '../utils/featureLog';
import { friendlyAuthError } from '../utils/authError';
import './LoginPage.css';

const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const { user, loginWithEmail, registerWithEmail, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const isRegister = mode === 'register';

  // 已登入（非遊客）時直接進入儀表板，避免重複登入
  React.useEffect(() => {
    if (user && user.role !== 'guest') {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate]);

  const toggleMode = () => {
    setMode((m) => (m === 'login' ? 'register' : 'login'));
    setError('');
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        await registerWithEmail(email, password);
        featureLog('auth', 'register', { method: 'email' });
      } else {
        await loginWithEmail(email, password);
        featureLog('auth', 'login', { method: 'email' });
      }
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(friendlyAuthError(err, mode));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError('');
    setLoading(true);

    try {
      await loginWithGoogle();
      featureLog('auth', 'login', { method: 'google' });
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page" id="main-content">
      <div className="login-container" role="main">
        <div className="login-brand">
          <div className="login-logo" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1>Nerilo</h1>
          <p className="subtitle">端對端加密的 P2P 聊天</p>
        </div>

        <form onSubmit={handleEmailSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">電子郵件</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">密碼</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isRegister ? 6 : undefined}
              disabled={loading}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
            />
            {isRegister && <span className="field-hint">密碼至少 6 個字元</span>}
          </div>

          {error && <div className="error-message" role="alert">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (isRegister ? '註冊中...' : '登入中...') : isRegister ? '註冊' : '登入'}
          </button>

          <p className="auth-toggle">
            {isRegister ? '已經有帳號了？' : '還沒有帳號？'}
            <button type="button" className="auth-toggle-link" onClick={toggleMode}>
              {isRegister ? '改用登入' : '建立新帳號'}
            </button>
          </p>
        </form>

        <div className="divider">
          <span>或</span>
        </div>

        <button
          type="button"
          className="btn-google"
          onClick={handleGoogleLogin}
          disabled={loading}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          使用 Google 登入
        </button>

        <p className="login-trust">
          <span aria-hidden="true">🔒</span> 訊息端對端加密，不經伺服器留存內容
        </p>
      </div>
    </div>
  );
};

export default LoginPage;


