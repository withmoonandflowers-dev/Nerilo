import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { RoomService } from '../services/RoomService';
import type { P2PRoom } from '../types';
import './WaitingRoomPage.css';

const WaitingRoomPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [room, setRoom] = useState<P2PRoom | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [isTimeout, setIsTimeout] = useState(false);

  // 監聽房間狀態變化
  useEffect(() => {
    if (!roomId) return;

    const unsubscribe = RoomService.subscribeRoom(roomId, (updatedRoom) => {
      if (!updatedRoom) {
        console.warn('[WaitingRoomPage] Room not found, navigating to dashboard', { roomId });
        navigate('/dashboard');
        return;
      }

      console.log('[WaitingRoomPage] Room updated', {
        roomId,
        status: updatedRoom.status,
        participants: updatedRoom.participants.length,
        participantIds: updatedRoom.participants,
        ownerUid: updatedRoom.ownerUid,
        timestamp: new Date().toISOString(),
      });

      // 如果房間狀態是 closed，導航回 dashboard
      if (updatedRoom.status === 'closed') {
        console.warn('[WaitingRoomPage] Room is closed, navigating to dashboard', { roomId });
        navigate('/dashboard');
        return;
      }

      setRoom(updatedRoom);

      // 如果房間狀態變為 open，自動轉到聊天頁面（允許單人進入）
      if (updatedRoom.status === 'open') {
        console.log('[WaitingRoomPage] Room is open, navigating to chat', {
          roomId,
          participants: updatedRoom.participants.length,
        });
        navigate(`/chat/${roomId}`);
        return;
      }

      // 檢查是否超時
      if (RoomService.isRoomTimeout(updatedRoom)) {
        console.log('[WaitingRoomPage] Room timeout detected', { roomId });
        setIsTimeout(true);
      }
    });

    return unsubscribe;
  }, [roomId, navigate]);

  // 定期檢查房間狀態（作為備用機制，防止監聽延遲）
  useEffect(() => {
    if (!roomId || !room) return;

    const checkRoomStatus = async () => {
      const currentRoom = await RoomService.getRoom(roomId);
      if (!currentRoom) {
        console.warn('[WaitingRoomPage] Periodic check: Room not found', { roomId });
        navigate('/dashboard');
        return;
      }

      if (currentRoom.status === 'closed') {
        console.warn('[WaitingRoomPage] Periodic check: Room is closed', { roomId });
        navigate('/dashboard');
        return;
      }

      // 如果房間狀態為 open，自動轉到聊天頁面（允許單人進入）
      if (currentRoom.status === 'open') {
        console.log('[WaitingRoomPage] Periodic check: Room is open, navigating to chat', {
          roomId,
          participants: currentRoom.participants.length,
        });
        navigate(`/chat/${roomId}`);
      }
    };

    const interval = setInterval(checkRoomStatus, 2000); // 每 2 秒檢查一次
    return () => clearInterval(interval);
  }, [roomId, room, navigate]);

  // 計算剩餘時間
  useEffect(() => {
    if (!room || room.status !== 'waiting' || !room.waitingStartedAt || !room.waitingTimeout) {
      return;
    }

    const updateTimeRemaining = () => {
      const elapsed = Date.now() - room.waitingStartedAt!;
      const remaining = Math.max(0, room.waitingTimeout! - elapsed);
      setTimeRemaining(remaining);

      if (remaining === 0) {
        setIsTimeout(true);
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 1000);

    return () => clearInterval(interval);
  }, [room]);

  // 處理超時
  useEffect(() => {
    if (isTimeout && room && room.status === 'waiting') {
      // 超時後自動關閉房間
      if (user && room.ownerUid === user.uid) {
        RoomService.closeRoom(roomId!, user.uid).catch(console.error);
      }
    }
  }, [isTimeout, room, user, roomId]);

  const handleCancel = async () => {
    if (roomId && user && room) {
      if (room.ownerUid === user.uid) {
        await RoomService.closeRoom(roomId, user.uid);
      } else {
        await RoomService.leaveRoom(roomId, user.uid);
      }
      navigate('/dashboard');
    }
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}/chat/${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      alert('連結已複製到剪貼簿！');
    }).catch(() => {
      // 降級方案
      const textArea = document.createElement('textarea');
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      alert('連結已複製到剪貼簿！');
    });
  };

  const formatTime = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!room || !user) {
    return (
      <div className="waiting-room-page">
        <div className="loading">載入中...</div>
      </div>
    );
  }

  const isOwner = room.ownerUid === user.uid;
  const participantCount = room.participants.length;

  return (
    <div className="waiting-room-page">
      <div className="waiting-room-container">
        <div className="waiting-room-header">
          <h1>等待連線</h1>
          <p className="room-id">房間 ID: {roomId?.substring(0, 8)}...</p>
        </div>

        <div className="waiting-room-content">
          {isTimeout ? (
            <div className="timeout-message">
              <div className="timeout-icon">⏰</div>
              <h2>等待時間已過</h2>
              <p>沒有人在這段時間內加入房間</p>
              <button onClick={handleCancel} className="btn-primary">
                返回首頁
              </button>
            </div>
          ) : (
            <>
              <div className="waiting-status">
                <div className="status-icon">⏳</div>
                <h2>等待其他人加入...</h2>
                <p className="participant-count">
                  目前參與者: {participantCount} 人
                </p>
              </div>

              {room.waitingTimeout && room.waitingStartedAt && (
                <div className="timer">
                  <div className="timer-label">剩餘時間</div>
                  <div className="timer-value">{formatTime(timeRemaining)}</div>
                </div>
              )}

              <div className="share-section">
                <h3>分享房間連結</h3>
                <div className="share-buttons">
                  <button onClick={handleCopyLink} className="btn-secondary">
                    📋 複製連結
                  </button>
                </div>
                <p className="share-hint">
                  將連結分享給其他人，讓他們加入這個房間
                </p>
              </div>

              {participantCount >= 2 && room.status === 'waiting' && (
                <div className="ready-message">
                  <p>✓ 已有人加入，即將開始連線...</p>
                </div>
              )}
              
              {room.status === 'waiting' && participantCount === 1 && isOwner && (
                <div className="ready-message">
                  <p>✓ 房間已準備好，可以開始聊天</p>
                  <button 
                    onClick={async () => {
                      // 手動啟動房間
                      if (roomId && user && room.ownerUid === user.uid) {
                        try {
                          await RoomService.activateRoom(roomId, user.uid);
                          navigate(`/chat/${roomId}`);
                        } catch (error) {
                          console.error('[WaitingRoomPage] Failed to activate room', error);
                          alert('啟動房間失敗，請稍後再試');
                        }
                      }
                    }}
                    className="btn-primary"
                    style={{ marginTop: '12px' }}
                  >
                    開始聊天
                  </button>
                </div>
              )}

              <div className="action-buttons">
                <button onClick={handleCancel} className="btn-cancel">
                  {isOwner ? '取消房間' : '離開'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default WaitingRoomPage;
