import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './LandingPage.css';

const LandingPage: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Already logged in → go to dashboard
  React.useEffect(() => {
    if (user && user.role !== 'guest') {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate]);

  return (
    <div className="landing-page" id="main-content">
      <header className="landing-header">
        <h1 className="landing-logo">Nerilo</h1>
        <nav className="landing-nav">
          <button className="btn-nav" onClick={() => navigate('/login')}>登入</button>
          <button className="btn-nav-primary" onClick={() => navigate('/dashboard')}>開始使用</button>
        </nav>
      </header>

      <main className="landing-hero">
        <h2 className="hero-title">安全、私密的 P2P 即時聊天</h2>
        <p className="hero-subtitle">
          無需安裝，開啟瀏覽器即可使用。訊息透過端對端加密直接傳送，不經過任何伺服器。
        </p>

        <div className="hero-features">
          <div className="feature-card">
            <span className="feature-icon" aria-hidden="true">&#x1F512;</span>
            <h3>端對端加密</h3>
            <p>AES-256-GCM 加密，ECDH 金鑰交換。只有你和對方能讀取訊息。</p>
          </div>
          <div className="feature-card">
            <span className="feature-icon" aria-hidden="true">&#x1F310;</span>
            <h3>點對點直連</h3>
            <p>WebRTC 技術實現瀏覽器間直接通訊，訊息不經過中間伺服器。</p>
          </div>
          <div className="feature-card">
            <span className="feature-icon" aria-hidden="true">&#x26A1;</span>
            <h3>即開即用</h3>
            <p>純瀏覽器運作，無需下載或安裝任何軟體。分享連結即可開始對話。</p>
          </div>
        </div>

        <div className="hero-cta">
          <button className="btn-cta-primary" onClick={() => navigate('/dashboard')}>
            免費開始使用
          </button>
          <button className="btn-cta-secondary" onClick={() => navigate('/login')}>
            登入現有帳號
          </button>
        </div>
      </main>

      <footer className="landing-footer">
        <p>Nerilo &mdash; 隱私優先的即時通訊平台</p>
      </footer>
    </div>
  );
};

export default LandingPage;
