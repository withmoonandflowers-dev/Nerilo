import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useFeatures } from '../contexts/FeatureContext';
import { useServices } from '../contexts/ServicesContext';
import { useToast } from '../contexts/ToastContext';
import { SkeletonRoomCard, SkeletonFeatureCard } from '../components/Skeleton/Skeleton';
import { ShareModal } from '../components/ShareModal/ShareModal';
import { WelcomeModal } from '../components/WelcomeModal/WelcomeModal';
import type { P2PRoom } from '../types';
import { featureLog } from '../utils/featureLog';
import { logger } from '../utils/logger';
import './DashboardPage.css';

const DashboardPage: React.FC = () => {
  const { user, loading: authLoading, logout } = useAuth();
  const { searchFeatures } = useFeatures();
  const { roomService } = useServices();
  const [searchKeyword, setSearchKeyword] = useState('');
  const [rooms, setRooms] = useState<P2PRoom[]>([]);
  const [publicRooms, setPublicRooms] = useState<P2PRoom[]>([]);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [shareRoomId, setShareRoomId] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const isGuest = user?.role === 'guest';

  // Onboarding 第一階段：首次造訪顯示歡迎彈窗（每個瀏覽器只顯示一次）
  const ONBOARDED_KEY = 'nerilo_onboarded';
  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDED_KEY)) {
        setShowWelcome(true);
        featureLog('onboarding', 'welcome_shown', {});
      }
    } catch {
      // localStorage 不可用（隱私模式）時略過，不阻擋使用
    }
  }, []);

  const dismissWelcome = (reason: 'create' | 'invite' | 'later') => {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
    } catch {
      // 略過
    }
    featureLog('onboarding', 'welcome_dismissed', { reason });
    setShowWelcome(false);
  };

  const handleWelcomeCreateRoom = () => {
    dismissWelcome('create');
    // Option A：guest 無法建房，引導登入並說明原因
    if (!user || isGuest) {
      toast.info('登入後房間才屬於你，也才能管理它');
      navigate('/login');
      return;
    }
    setShowCreateRoom(true);
  };

  const handleWelcomeHaveInvite = () => {
    dismissWelcome('invite');
    toast.info('把朋友傳給你的邀請連結貼到網址列即可加入，或從下方公開房間選擇');
  };

  const filteredFeatures = searchFeatures(searchKeyword);

  useEffect(() => {
    if (!user) return;

    const unsubscribe = roomService.subscribeUserRooms(user.uid, (roomList) => {
      logger.info('[Dashboard] subscribeUserRooms for uid', user.uid, roomList);
      setRooms(roomList);
    });

    return unsubscribe;
  }, [user, roomService]);

  // 監聽所有公開房間（供訪客與一般使用者瀏覽）
  useEffect(() => {
    const unsubscribe = roomService.subscribePublicRooms((roomList) => {
      logger.info('[Dashboard] subscribePublicRooms', roomList);
      setPublicRooms(roomList);
    });
    return unsubscribe;
  }, [roomService]);

  const handleAuthButtonClick = async () => {
    if (isGuest) {
      navigate('/login');
      return;
    }
    featureLog('auth', 'logout', {});
    await logout();
    navigate('/login');
  };

  const handleFeatureClick = (route: string) => {
    navigate(route);
  };

  const handleCreateRoom = async () => {
    if (!user) {
      navigate('/login');
      return;
    }

    // 安全檢查：只允許已登入的用戶建立房間（不允許匿名/guest 用戶）
    // 在測試環境中，允許 guest 用戶建立房間（用於 E2E 測試）
    const isTestEnv = import.meta.env.MODE === 'test' || 
                      (import.meta.env.VITE_ALLOW_GUEST_CREATE_ROOM as string | undefined) === 'true' ||
                      (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__PLAYWRIGHT_TEST__ === true);
    
    if (!isTestEnv && (user.role === 'guest' || !user.uid)) {
      logger.warn('[Dashboard] Guest user attempted to create room', {
        uid: user.uid,
        role: user.role,
      });
      toast.warning('建立房間需要登入，請先登入您的帳號');
      navigate('/login');
      return;
    }

    if (isCreating) return;

    setIsCreating(true);
    try {
      // 目前房間名稱為選填，暫存於前端（未寫入 Firestore）
      const ownerName = user.displayName || user.email || '使用者';
      logger.info('[Dashboard] Creating room', {
        uid: user.uid,
        role: user.role,
        ownerName,
        isPrivate,
      });
      
      // 建立房間（requireAuth: true 確保只允許登入用戶）
      const roomId = await roomService.createRoom(
        user.uid, 
        ownerName, 
        isPrivate,
        [],
        5 * 60 * 1000, // 5 分鐘超時
        true // 要求已登入
      );
      
      featureLog('dashboard', 'room_created', { roomId });
      logger.info('[Dashboard] Room created successfully', { roomId });
      navigate(`/waiting/${roomId}`);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '請稍後再試';
      logger.error('[Dashboard] Failed to create room', {
        uid: user.uid,
        error: errMsg,
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      toast.error(`建立房間失敗：${errMsg}`);
    } finally {
      setIsCreating(false);
      setShowCreateRoom(false);
      setNewRoomName('');
    }
  };

  const handleJoinRoom = async (roomId: string) => {
    if (!user) {
      navigate('/login');
      return;
    }

    try {
      featureLog('dashboard', 'join_room_clicked', { roomId, uid: user.uid });
      logger.info('[Dashboard] handleJoinRoom called', { roomId, uid: user.uid });

      // 先取得房間資訊，判斷狀態
      const room = await roomService.getRoom(roomId);
      if (!room) {
        logger.warn('[Dashboard] Room not found', { roomId });
        toast.error('房間不存在');
        return;
      }

      logger.info('[Dashboard] Room found', {
        roomId,
        status: room.status,
        participants: room.participants.length,
      });

      // 檢查房間狀態
      if (room.status === 'closed') {
        logger.warn('[Dashboard] Room is closed', { roomId });
        toast.warning('房間已關閉');
        return;
      }

      await roomService.joinRoom(roomId, user.uid);
      featureLog('dashboard', 'room_joined_from_list', { roomId });

      const updatedRoom = await roomService.getRoom(roomId);
      if (!updatedRoom) {
        logger.warn('[Dashboard] Room not found after join', { roomId });
        toast.error('房間不存在');
        return;
      }

      logger.info('[Dashboard] Room after join', {
        roomId,
        status: updatedRoom.status,
        participants: updatedRoom.participants.length,
      });

      // 根據房間狀態導航
      // 如果房間是 waiting 狀態，轉到等待頁面（但現在單人也可以進入，所以會很快轉為 open）
      if (updatedRoom.status === 'waiting') {
        logger.info('[Dashboard] Navigating to waiting page', { roomId });
        navigate(`/waiting/${roomId}`);
      } else {
        // open 狀態直接進入聊天頁面
        logger.info('[Dashboard] Navigating to chat page', { roomId });
        navigate(`/chat/${roomId}`);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '';
      logger.error('[Dashboard] Join room failed', { roomId, error: errMsg });
      if (errMsg === '房間已關閉') {
        toast.warning('房間已關閉');
      } else {
        toast.error('加入房間失敗，請稍後再試');
      }
    }
  };

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="header-content">
          <h1>Nerilo</h1>
          <div className="user-info">
            <span>{user?.displayName || user?.email}</span>
            <span className="role-badge">{user?.role}</span>
            <button onClick={handleAuthButtonClick} className="btn-logout" aria-label={isGuest ? '登入帳號' : '登出帳號'}>
              {isGuest ? '登入' : '登出'}
            </button>
          </div>
        </div>
      </header>

      {authLoading && (
        <main id="main-content" className="dashboard-main" aria-busy="true">
          <section className="rooms-section" aria-label="我的房間">
            <div className="section-header"><h2>我的房間</h2></div>
            <div className="rooms-list">
              <SkeletonRoomCard />
              <SkeletonRoomCard />
              <SkeletonRoomCard />
            </div>
          </section>
          <section className="features-section">
            <h2>功能</h2>
            <div className="features-grid">
              <SkeletonFeatureCard />
              <SkeletonFeatureCard />
              <SkeletonFeatureCard />
            </div>
          </section>
        </main>
      )}
      {!authLoading && (
      <main id="main-content" className="dashboard-main">
        {/* 房間區塊 */}
        <section className="rooms-section" aria-label="我的房間">
          <div className="section-header">
            <h2>我的房間</h2>
            {user && (
              <button
                className="btn-primary"
                onClick={() => setShowCreateRoom(!showCreateRoom)}
                aria-expanded={showCreateRoom}
                aria-label={showCreateRoom ? '取消建立房間' : '建立新房間'}
              >
                {showCreateRoom ? '取消' : '+ 建立新房間'}
              </button>
            )}
          </div>

            {showCreateRoom && (
              <div className="create-room-form">
                <input
                  type="text"
                  placeholder="輸入房間名稱（選填）"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  className="room-name-input"
                  aria-label="房間名稱"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleCreateRoom();
                    }
                  }}
                />
                <button
                  className="btn-create"
                  onClick={handleCreateRoom}
                  disabled={isCreating || !user || (user.role === 'guest' && import.meta.env.MODE !== 'test' && (import.meta.env.VITE_ALLOW_GUEST_CREATE_ROOM as string) !== 'true')}
                  title={user?.role === 'guest' && import.meta.env.MODE !== 'test' && (import.meta.env.VITE_ALLOW_GUEST_CREATE_ROOM as string) !== 'true' ? '建立房間需要登入' : ''}
                >
                  {isCreating ? '建立中...' : '建立房間'}
                </button>
                <label className="private-checkbox">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                    disabled={user?.role === 'guest'}
                  />
                  <span>私有房間（不顯示在公開列表）</span>
                </label>
              </div>
            )}
            
            {!user && (
              <div className="guest-notice">
                <p>您目前以遊客身份使用，可以加入現有房間。若要建立房間，請先登入。</p>
                <button
                  className="btn-primary"
                  onClick={() => navigate('/login')}
                >
                  前往登入
                </button>
              </div>
            )}

            <div className="rooms-list">
              {rooms.length === 0 ? (
                <div className="empty-state">
                  <p>{user ? '還沒有房間，建立一個新房間開始聊天吧！' : '還沒有房間，登入後可以建立新房間'}</p>
                </div>
              ) : (
                rooms.map((room) => (
                  <div
                    key={room.roomId}
                    className="room-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`進入房間 ${room.roomId.substring(0, 8)}，${room.participants.length} 位參與者`}
                    onClick={() => handleJoinRoom(room.roomId)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleJoinRoom(room.roomId); } }}
                  >
                    <div className="room-info">
                      <h3>房間 {room.roomId.substring(0, 8)}...</h3>
                      <p>
                        參與者: {room.participants.length} 人 |{' '}
                        {new Date(room.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="room-actions">
                      <button
                        className="btn-share-small"
                        onClick={(e) => { e.stopPropagation(); setShareRoomId(room.roomId); }}
                        aria-label={`分享房間 ${room.roomId.substring(0, 8)}`}
                      >
                        &#x1F4E4;
                      </button>
                      <button className="btn-join" aria-label={`進入房間 ${room.roomId.substring(0, 8)}`}>進入</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

        {/* 公開房間區塊 */}
        <section className="rooms-section" aria-label="公開房間">
          <div className="section-header">
            <h2>公開房間</h2>
          </div>

          <div className="rooms-list">
            {publicRooms.length === 0 ? (
              <div className="empty-state">
                <p>目前沒有公開房間，請稍後再試。</p>
              </div>
            ) : (
              publicRooms.map((room) => (
                <div
                  key={room.roomId}
                  className="room-card"
                  role="button"
                  tabIndex={0}
                  aria-label={`進入公開房間 ${room.roomId.substring(0, 8)}，房主 ${room.ownerName || room.ownerUid.substring(0, 6)}`}
                  onClick={() => handleJoinRoom(room.roomId)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleJoinRoom(room.roomId); } }}
                >
                  <div className="room-info">
                    <h3>房間 {room.roomId.substring(0, 8)}...</h3>
                    <p>
                      房主：{room.ownerName || room.ownerUid.substring(0, 6)}
                    </p>
                    <p>
                      參與者: {room.participants.length} 人 |{' '}
                      {new Date(room.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button className="btn-join" aria-label={`進入房間 ${room.roomId.substring(0, 8)}`}>進入</button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 功能區塊 */}
        <section className="features-section">
          <h2>功能</h2>
          <div className="search-section" role="search">
            <input
              type="text"
              placeholder="搜尋功能..."
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="search-input"
              aria-label="搜尋功能"
            />
          </div>

          <div className="features-grid">
            {filteredFeatures.map((feature) => (
              <div
                key={feature.featureId}
                className="feature-card"
                role="button"
                tabIndex={0}
                aria-label={`${feature.name}: ${feature.description}`}
                onClick={() => handleFeatureClick(feature.route)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleFeatureClick(feature.route); } }}
              >
                {feature.icon && <div className="feature-icon" aria-hidden="true">{feature.icon}</div>}
                <h3>{feature.name}</h3>
                <p>{feature.description}</p>
              </div>
            ))}
          </div>

          {filteredFeatures.length === 0 && (
            <div className="empty-state">
              <p>沒有找到符合的功能</p>
            </div>
          )}
        </section>
      </main>
      )}

      {shareRoomId && (
        <ShareModal
          roomId={shareRoomId}
          isOpen={true}
          onClose={() => setShareRoomId(null)}
        />
      )}

      <WelcomeModal
        isOpen={showWelcome}
        onCreateRoom={handleWelcomeCreateRoom}
        onHaveInvite={handleWelcomeHaveInvite}
        onClose={() => dismissWelcome('later')}
      />
    </div>
  );
};

export default DashboardPage;


