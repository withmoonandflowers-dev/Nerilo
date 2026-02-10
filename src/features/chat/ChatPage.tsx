/**
 * 重構後的 ChatPage
 * 使用模組化的 hooks 來管理 P2P 連線、房間訂閱和訊息
 */

import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { RoomService } from '../../services/RoomService';
import type { ConnectionState, P2PRoom } from '../../types';
import { useP2PArchitecture } from './hooks/useP2PArchitecture';
import { useStarTopology } from './hooks/useStarTopology';
import { useMeshTopology } from './hooks/useMeshTopology';
import { useRoomSubscription } from './hooks/useRoomSubscription';
import { useChatMessages } from './hooks/useChatMessages';
import './ChatPage.css';

const ChatPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const p2pInitializedRef = useRef(false);

  // Hooks
  const architecture = useP2PArchitecture();
  const starTopology = useStarTopology();
  const meshTopology = useMeshTopology();
  const roomSubscription = useRoomSubscription();
  const { messages, addMessage, setMessagesList } = useChatMessages();

  // 避免在 React StrictMode（開發環境）下重複初始化同一個 room + uid
  const initKey = user && roomId ? `room-${roomId}-uid-${user.uid}` : null;

  useEffect(() => {
    if (!roomId) return;
    if (!user) return;

    if (initKey) {
      // 使用 window 全域旗標避免 StrictMode 導致的重複初始化
      const w = window as any;
      w.__neriloChatInitRooms = w.__neriloChatInitRooms || {};
      if (w.__neriloChatInitRooms[initKey]) {
        return;
      }
      w.__neriloChatInitRooms[initKey] = true;
    }

    initializedRef.current = true;

    const init = async () => {
      try {
        const uid = user.uid;
        console.log('[ChatPage] init started', { roomId, uid });

        // 1. 檢查房間是否存在
        const room = await RoomService.getRoom(roomId);
        if (!room) {
          console.warn('[ChatPage] Room not found, navigating to dashboard', { roomId });
          navigate('/dashboard');
          return;
        }

        console.log('[ChatPage] Room found', {
          roomId,
          status: room.status,
          participants: room.participants.length,
          ownerUid: room.ownerUid,
        });

        // 2. 檢查房間狀態
        if (room.status === 'closed') {
          console.warn('[ChatPage] Room is closed, navigating to dashboard', { roomId });
          navigate('/dashboard');
          return;
        }

        // 3. 加入房間
        console.log('[ChatPage] Calling joinRoom', { roomId, uid });
        try {
          await RoomService.joinRoom(roomId, uid);
          console.log('[ChatPage] joinRoom completed', { roomId, uid });

          // 等待 Firestore 同步更新
          await new Promise(resolve => setTimeout(resolve, 500));

          // 再次讀取房間狀態
          const roomAfterJoin = await RoomService.getRoom(roomId, true);
          if (!roomAfterJoin) {
            console.warn('[ChatPage] Room not found after join, navigating to dashboard', { roomId });
            navigate('/dashboard');
            return;
          }

          // 如果房間狀態仍然是 waiting，且參與者數量 < 2，轉到等待頁面
          if (roomAfterJoin.status === 'waiting' && roomAfterJoin.participants.length < 2) {
            console.log('[ChatPage] Room still waiting after join, navigating to waiting page', {
              roomId,
              participantCount: roomAfterJoin.participants.length,
            });
            navigate(`/waiting/${roomId}`);
            return;
          }
        } catch (error: any) {
          console.error('[ChatPage] joinRoom failed', { roomId, uid, error: error.message });
          if (error.message === '房間已關閉') {
            navigate('/dashboard');
            return;
          }
          throw error;
        }

        // 4. 初始化 P2P 連線
        const initializeP2P = async (room: P2PRoom, effectiveParticipantCount?: number) => {
          if (p2pInitializedRef.current) {
            const starState = starTopology.getState();
            const meshState = meshTopology.getState();
            if (starState.isInitialized || meshState.isInitialized) {
              return; // 已經初始化
            }
          }

          const effectiveCount = effectiveParticipantCount ?? room.participants.length;
          if (room.status !== 'open' || effectiveCount < 2) {
            return;
          }

          // 決定架構
          const decision = architecture.decide(room, effectiveCount);
          console.log('[ChatPage] Deciding P2P architecture', {
            roomId,
            decision,
          });

          try {
            p2pInitializedRef.current = true;

            if (decision.type === 'mesh') {
              // 使用 Mesh 架構
              console.log('[ChatPage] Initializing Mesh topology', {
                roomId,
                uid,
                participantCount: effectiveCount,
              });

              await meshTopology.initialize(
                roomId,
                uid,
                setConnectionState,
                addMessage
              );
            } else {
              // 使用星型拓撲
              const isInitiator = room.ownerUid === uid;
              console.log('[ChatPage] Initializing Star topology', {
                roomId,
                uid,
                isInitiator,
              });

              await starTopology.initialize(
                roomId,
                uid,
                isInitiator,
                setConnectionState,
                addMessage
              );
            }
          } catch (error) {
            console.error('[ChatPage] Error initializing P2P', {
              roomId,
              architecture: decision.type,
              error,
            });
            p2pInitializedRef.current = false;
            setConnectionState('failed');
          }
        };

        // 5. 訂閱房間變化
        await roomSubscription.subscribe(roomId, {
          onRoomClosed: () => {
            console.warn('[ChatPage] Room is closed, navigating to dashboard', { roomId });
            navigate('/dashboard');
          },
          onRoomWaiting: () => {
            console.log('[ChatPage] Room is still waiting, navigating to waiting page', { roomId });
            navigate(`/waiting/${roomId}`);
          },
          onRoomOpen: async (room, effectiveParticipantCount) => {
            console.log('[ChatPage] Room is open, initializing P2P', {
              roomId,
              participantCount: room.participants.length,
              effectiveParticipantCount,
            });

            const starState = starTopology.getState();
            const meshState = meshTopology.getState();

            // 如果還沒有初始化，且有效參與者數量 >= 2，初始化 P2P
            if (!starState.isInitialized && !meshState.isInitialized && effectiveParticipantCount >= 2) {
              await initializeP2P(room, effectiveParticipantCount);
            }
          },
          onRoomNotFound: () => {
            console.warn('[ChatPage] Room not found, navigating to dashboard', { roomId });
            navigate('/dashboard');
          },
        });

        // 6. 如果初始房間狀態是 open，立即嘗試初始化
        const initialRoom = await RoomService.getRoom(roomId, true);
        if (initialRoom && initialRoom.status === 'open') {
          let effectiveCount = initialRoom.participants.length;

          // 房間為 open 表示至少已有 2 人；若讀到 0 或 1 視為 Firestore 同步延遲
          if (effectiveCount < 2) {
            console.log('[ChatPage] Initial room has', effectiveCount, 'participant(s) but status is open (likely sync delay)', {
              roomId,
            });
            effectiveCount = 2;
          }

          if (effectiveCount >= 2) {
            await initializeP2P(initialRoom, effectiveCount);
          }
        }
      } catch (error) {
        console.error('[ChatPage] Error initializing chat:', error);
        setConnectionState('failed');
      }
    };

    init();

    return () => {
      // 清理資源
      roomSubscription.unsubscribe();
      starTopology.cleanup();
      meshTopology.cleanup();

      if (roomId && user) {
        RoomService.leaveRoom(roomId, user.uid).catch(console.error);
      }

      initializedRef.current = false;
      p2pInitializedRef.current = false;
    };
  }, [user, roomId, navigate, architecture, starTopology, meshTopology, roomSubscription, addMessage, setMessagesList]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    try {
      if (architecture.isMesh()) {
        await meshTopology.sendMessage(inputValue.trim());
      } else if (architecture.isStar()) {
        await starTopology.sendMessage(inputValue.trim());
      } else {
        console.warn('[ChatPage] No chat service available');
        return;
      }
      setInputValue('');
    } catch (error) {
      console.error('[ChatPage] Error sending message:', error);
    }
  };

  const handleLeaveRoom = async () => {
    if (roomId && user) {
      await RoomService.leaveRoom(roomId, user.uid);
      navigate('/dashboard');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const getConnectionStatusText = () => {
    switch (connectionState) {
      case 'connecting':
        return '連線中...';
      case 'connected':
        return '已連線';
      case 'failed':
        return '連線失敗';
      case 'closed':
        return '已斷線';
      default:
        return '未連線';
    }
  };

  return (
    <div className="chat-page">
      <div className="chat-header">
        <div className="header-left">
          <button onClick={handleLeaveRoom} className="btn-back">
            ← 返回
          </button>
          <h2>聊天室: {roomId?.substring(0, 8)}...</h2>
        </div>
        <div className={`connection-status ${connectionState}`}>
          {getConnectionStatusText()}
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg) => (
          <div
            key={msg.messageId}
            className={`message ${msg.from.startsWith(user?.uid || '') ? 'own' : 'other'}`}
          >
            <div className="message-content">
              {msg.deleted ? (
                <em className="deleted-message">訊息已刪除</em>
              ) : (
                <>
                  <p>{msg.content}</p>
                  {msg.edited && <span className="edited-badge">已編輯</span>}
                </>
              )}
            </div>
            <div className="message-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="輸入訊息..."
          disabled={connectionState !== 'connected'}
          rows={3}
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || connectionState !== 'connected'}
          className="send-button"
        >
          傳送
        </button>
      </div>
    </div>
  );
};

export default ChatPage;
