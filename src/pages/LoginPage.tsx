import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { featureLog } from '../utils/featureLog';
import { getFirebaseErrorMessage } from '../utils/firebaseErrorMessages';
import './LoginPage.css';

const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const { user, loginWithEmail, registerWithEmail, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  // 已登入（非遊客）時直接進入儀表板，避免重複登入
  React.useEffect(() => {
    if (user && user.role !== 'guest') {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegisterMode) {
        if (password.length < 6) {
          setError('密碼長度至少需要 6 個字元');
          setLoading(false);
          return;
        }
        await registerWithEmail(email, password);
        featureLog('auth', 'register', { method: 'email' });
      } else {
        await loginWithEmail(email, password);
        featureLog('auth', 'login', { method: 'email' });
      }
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(getFirebaseErrorMessage(err));
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
      setError(getFirebaseErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page" id="main-content">
      <div className="login-container" role="main">
        <h1>Nerilo</h1>
        <p className="subtitle">P2P 即時互動平台</p>
        <ul className="value-props">
          <li>端對端加密，訊息不經伺服器</li>
          <li>瀏覽器直接使用，無需安裝</li>
          <li>點對點直連，隱私優先</li>
        </ul>

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
              disabled={loading}
            />
          </div>

          {error && <div className="error-message" role="alert">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (isRegisterMode ? '註冊中...' : '登入中...') : (isRegisterMode ? '註冊' : '登入')}
          </button>
        </form>

        <p className="toggle-mode">
          {isRegisterMode ? '已有帳號？' : '沒有帳號？'}
          <button
            type="button"
            className="btn-link"
            onClick={() => { setIsRegisterMode(!isRegisterMode); setError(''); }}
          >
            {isRegisterMode ? '登入' : '註冊新帳號'}
          </button>
        </p>

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
      </div>
    </div>
  );
};

export default LoginPage;


