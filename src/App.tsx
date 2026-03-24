import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { FeatureProvider } from './contexts/FeatureContext';
import { ServicesProvider } from './contexts/ServicesContext';

// Lazy-loaded pages — 每個頁面會被打包成獨立 chunk
const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const WaitingRoomPage = lazy(() => import('./pages/WaitingRoomPage'));
const ChatPage = lazy(() => import('./features/chat/ChatPage'));

function LoadingFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <p>載入中...</p>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <ServicesProvider>
        <FeatureProvider>
          <Router>
            <Suspense fallback={<LoadingFallback />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/waiting/:roomId" element={<WaitingRoomPage />} />
                <Route path="/chat/:roomId" element={<ChatPage />} />
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Suspense>
          </Router>
        </FeatureProvider>
      </ServicesProvider>
    </AuthProvider>
  );
}

export default App;
