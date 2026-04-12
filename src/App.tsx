import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { FeatureProvider } from './contexts/FeatureContext';
import { ServicesProvider } from './contexts/ServicesContext';
import { ToastProvider } from './contexts/ToastContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppLoadingFallback } from './components/Skeleton/Skeleton';

// Lazy-loaded pages — 每個頁面會被打包成獨立 chunk
const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const WaitingRoomPage = lazy(() => import('./pages/WaitingRoomPage'));
const ChatPage = lazy(() => import('./features/chat/ChatPage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

function LoadingFallback() {
  return <AppLoadingFallback />;
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ServicesProvider>
          <FeatureProvider>
            <ToastProvider>
              <Router>
                <a href="#main-content" className="skip-to-content">
                  跳至主要內容
                </a>
                <Suspense fallback={<LoadingFallback />}>
                  <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/waiting/:roomId" element={<WaitingRoomPage />} />
                    <Route path="/chat/:roomId" element={<ChatPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/" element={<LandingPage />} />
                  </Routes>
                </Suspense>
              </Router>
            </ToastProvider>
          </FeatureProvider>
        </ServicesProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
