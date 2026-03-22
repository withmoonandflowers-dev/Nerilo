import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { FeatureProvider } from './contexts/FeatureContext';
import { ServicesProvider } from './contexts/ServicesContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import WaitingRoomPage from './pages/WaitingRoomPage';
import { featureRoutes } from './features/registry';

function App() {
  return (
    <AuthProvider>
      <ServicesProvider>
        <FeatureProvider>
          <Router>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/waiting/:roomId" element={<WaitingRoomPage />} />
              {featureRoutes.map(({ path, element }) => (
                <Route key={path} path={path} element={element} />
              ))}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Router>
        </FeatureProvider>
      </ServicesProvider>
    </AuthProvider>
  );
}

export default App;

