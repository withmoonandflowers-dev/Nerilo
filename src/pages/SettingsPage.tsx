import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { changeLanguage } from '../i18n';
import { requestNotificationPermission } from '../utils/notifications';
import i18n from '../i18n';
import './SettingsPage.css';

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [lang, setLang] = useState(i18n.language);
  const [notifEnabled, setNotifEnabled] = useState(false);

  useEffect(() => {
    if ('Notification' in window) {
      setNotifEnabled(Notification.permission === 'granted');
    }
  }, []);

  const handleLangChange = (newLang: string) => {
    setLang(newLang);
    changeLanguage(newLang);
  };

  const handleNotifToggle = async () => {
    if (notifEnabled) return; // Can't revoke via API
    const granted = await requestNotificationPermission();
    setNotifEnabled(granted);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="settings-page" id="main-content">
      <header className="settings-header">
        <button onClick={() => navigate('/dashboard')} className="btn-back">
          ← {lang === 'zh' ? '返回' : 'Back'}
        </button>
        <h1>{lang === 'zh' ? '設定' : 'Settings'}</h1>
      </header>

      <main className="settings-content">
        <section className="settings-section">
          <h2>{lang === 'zh' ? '語言' : 'Language'}</h2>
          <div className="settings-option">
            <button
              className={`lang-btn ${lang === 'zh' ? 'active' : ''}`}
              onClick={() => handleLangChange('zh')}
            >
              繁體中文
            </button>
            <button
              className={`lang-btn ${lang === 'en' ? 'active' : ''}`}
              onClick={() => handleLangChange('en')}
            >
              English
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2>{lang === 'zh' ? '通知' : 'Notifications'}</h2>
          <div className="settings-option">
            <label className="toggle-label">
              <span>{lang === 'zh' ? '瀏覽器通知' : 'Browser Notifications'}</span>
              <button
                className={`toggle-btn ${notifEnabled ? 'on' : 'off'}`}
                onClick={handleNotifToggle}
                aria-pressed={notifEnabled}
              >
                {notifEnabled ? 'ON' : 'OFF'}
              </button>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <h2>{lang === 'zh' ? '帳號' : 'Account'}</h2>
          <div className="settings-option">
            <span className="user-info">
              {user?.displayName || user?.email || user?.uid?.substring(0, 8)}
            </span>
            <span className="user-role">{user?.role}</span>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            {lang === 'zh' ? '登出' : 'Sign Out'}
          </button>
        </section>

        <section className="settings-section">
          <h2>{lang === 'zh' ? '關於' : 'About'}</h2>
          <p className="about-text">
            Nerilo v1.0 — {lang === 'zh' ? '隱私優先的 P2P 即時通訊' : 'Privacy-first P2P messaging'}
          </p>
          <p className="about-text">
            {lang === 'zh' ? '加密：AES-256-GCM + ECDH P-256' : 'Encryption: AES-256-GCM + ECDH P-256'}
          </p>
        </section>
      </main>
    </div>
  );
};

export default SettingsPage;
