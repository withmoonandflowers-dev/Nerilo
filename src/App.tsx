import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { FeatureProvider } from './contexts/FeatureContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import WaitingRoomPage from './pages/WaitingRoomPage';
import ChatPage from './features/chat/ChatPage';

function App() {
  return (
    <AuthProvider>
      <FeatureProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/dashboard"
              element={<DashboardPage />}
            />
            <Route
              path="/waiting/:roomId"
              element={<WaitingRoomPage />}
            />
            <Route
              path="/chat/:roomId"
              element={<ChatPage />}
            />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Router>
      </FeatureProvider>
    </AuthProvider>
  );
}

export default App;

