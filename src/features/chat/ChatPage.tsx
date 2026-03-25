/**
 * 重構後的 ChatPage
 * 使用模組化的 hooks 來管理 P2P 連線、房間訂閱和訊息
 */

import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useServices } from '../../contexts/ServicesContext';
import {
  sendMessageViaFirestore,
  subscribeToFirestoreMessages,
} from '../../services/FirestoreChatFallback';
import type { ConnectionState, P2PRoom, ChatMessage } from '../../types';
import { featureLog } from '../../utils/featureLog';
import { useP2PArchitecture } from './hooks/useP2PArchitecture';
import { useStarTopology } from './hooks/useStarTopology';
import { useMeshTopology } from './hooks/useMeshTopology';
import { useRoomSubscription } from './hooks/useRoomSubscription';
import { useChatMessages } from './hooks/useChatMessages';
import './ChatPage.css';

const ChatPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const { roomService, chatStorage } = useServices();
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [showConnectionHint, setShowConnectionHint] = useState(false);
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const p2pInitializedRef = useRef(false);
  const connectingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const architecture = useP2PArchitecture();
  const starTopology = useStarTopology({ chatStorage });
  const meshTopology = useMeshTopology({ chatStorage });
  const roomSubscription = useRoomSubscription({ roomService });
  const { messages, addMessage, setMessagesList } = useChatMessages();

  // 避免在 React StrictMode（開發環境）下重複初始化同一個 room + uid
  const initKey = user && roomId ? `room-${roomId}-uid-${user.uid}` : null;

  useEffect(() => {
    if (!roomId) return;
    if (!user) return;

    if (initKey) {
      // 使用 window 全域旗標避免 StrictMode 導致的重複初始化
      const w = window as unknown as Record<string, Record<string, boolean>>;
      w.__neriloChatInitRooms = w.__neriloChatInitRooms || {};
      if (w.__neriloChatInitRooms[initKey]) {
        return;
      }
      w.__neriloChatInitRooms[initKey] = true;
    }

    initializedRef.current = true;

    // 如果 cleanup 在 async init() 執行期間被呼叫（例如 React StrictMode 雙重掛載），
    // 這個 guard 可以讓 init() 提前返回，避免操作已清理的資源。
    const isMounted = () => initializedRef.current;

    const init = async () => {
      try {
        const uid = user.uid;
        featureLog('chat', 'init', { roomId, uid });
        console.log('[ChatPage] init started', { roomId, uid });

        // 1. 檢查房間是否存在
        const room = await roomService.getRoom(roomId);
        if (!isMounted()) return; // guard: cleanup ran while awaiting
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
          await roomService.joinRoom(roomId, uid);
          if (!isMounted()) return; // guard: cleanup ran during joinRoom (retry loop)
          featureLog('chat', 'room_joined', { roomId, uid });
          console.log('[ChatPage] joinRoom completed', { roomId, uid });
          setHasJoinedRoom(true);

          // 等待 Firestore 同步更新
          await new Promise(resolve => setTimeout(resolve, 500));
          if (!isMounted()) return;

          // 再次讀取房間狀態
          const roomAfterJoin = await roomService.getRoom(roomId, true);
          if (!isMounted()) return;
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
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : '';
          console.error('[ChatPage] joinRoom failed', { roomId, uid, error: errMsg });
          if (!isMounted()) return;
          if (errMsg === '房間已關閉') {
            navigate('/dashboard');
            return;
          }
          throw error;
        }

        // 4. 初始化 P2P 連線（含互斥鎖：防止兩條路徑同時觸發）
        const initializeP2P = async (room: P2PRoom, effectiveParticipantCount?: number) => {
          // ── 互斥鎖 ── p2pInitializedRef 在 await 之前設為 true，
          // 確保即使兩條路徑（onRoomOpen + 直接讀取）同時觸發，只有第一個能進入。
          if (p2pInitializedRef.current) {
            return;
          }
          p2pInitializedRef.current = true;

          const effectiveCount = effectiveParticipantCount ?? room.participants.length;
          if (room.status !== 'open' || effectiveCount < 2) {
            p2pInitializedRef.current = false;
            return;
          }

          // 決定架構
          const decision = architecture.decide(room, effectiveCount);
          featureLog('chat', 'architecture_decided', { roomId, type: decision.type });
          console.log('[ChatPage] Deciding P2P architecture', {
            roomId,
            decision,
          });

          try {

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

        if (!isMounted()) return;

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
            console.log('[ChatPage] Room is open via subscription', {
              roomId,
              effectiveParticipantCount,
            });
            // initializeP2P 內部已有互斥鎖，直接呼叫即可
            await initializeP2P(room, effectiveParticipantCount);
          },
          onRoomNotFound: () => {
            console.warn('[ChatPage] Room not found, navigating to dashboard', { roomId });
            navigate('/dashboard');
          },
        });

        if (!isMounted()) return;

        // 6. 如果初始房間狀態是 open，立即嘗試初始化
        const initialRoom = await roomService.getRoom(roomId, true);
        if (!isMounted()) return;
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
        roomService.leaveRoom(roomId, user.uid).catch(console.error);
      }

      // 清除 StrictMode 防重入旗標，讓 re-mount（開發模式下的雙重渲染）能正常重新初始化
      if (initKey) {
        const w = window as unknown as Record<string, Record<string, boolean>>;
        if (w.__neriloChatInitRooms) {
          delete w.__neriloChatInitRooms[initKey];
        }
      }

      initializedRef.current = false;
      p2pInitializedRef.current = false;
    };
  }, [user, roomId, navigate, roomService, architecture, starTopology, meshTopology, roomSubscription, addMessage, setMessagesList]);

  // Firestore 備援：訂閱房間訊息，P2P 未連線時對方經 Firestore 送的訊息也能顯示
  // 必須等 joinRoom 完成後才啟動，否則第三人（尚未在 participants 中）會觸發 permission-denied
  useEffect(() => {
    if (!roomId || !user || !hasJoinedRoom) return;
    const unsubscribe = subscribeToFirestoreMessages(roomId, addMessage);
    return () => unsubscribe();
  }, [roomId, user, addMessage, hasJoinedRoom]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!inputValue.trim() || !user || !roomId) return;

    const content = inputValue.trim();
    setInputValue('');

    try {
      if (connectionState === 'connected') {
        if (architecture.isMesh()) {
          await meshTopology.sendMessage(content);
          featureLog('chat', 'message_sent', { roomId, channel: 'p2p_mesh' });
        } else if (architecture.isStar()) {
          await starTopology.sendMessage(content);
          featureLog('chat', 'message_sent', { roomId, channel: 'p2p_star' });
        } else {
          console.warn('[ChatPage] No chat service available');
          return;
        }
      } else {
        const messageId = await sendMessageViaFirestore(roomId, user.uid, content);
        featureLog('chat', 'message_sent', { roomId, channel: 'firestore_fallback' });
        const fallbackMessage: ChatMessage = {
          messageId,
          from: user.uid,
          content,
          timestamp: Date.now(),
        };
        addMessage(fallbackMessage);
      }
    } catch (error) {
      console.error('[ChatPage] Error sending message:', error);
    }
  };

  const handleLeaveRoom = async () => {
    if (roomId && user) {
      featureLog('chat', 'leave_room', { roomId, uid: user.uid });
      await roomService.leaveRoom(roomId, user.uid);
      navigate('/dashboard');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 連線中逾時提示：超過 45 秒仍為「連線中」時顯示操作說明
  useEffect(() => {
    if (connectionState === 'connecting') {
      setShowConnectionHint(false);
      connectingTimeoutRef.current = setTimeout(() => setShowConnectionHint(true), 45000);
      return () => {
        if (connectingTimeoutRef.current) {
          clearTimeout(connectingTimeoutRef.current);
          connectingTimeoutRef.current = null;
        }
      };
    }
    setShowConnectionHint(false);
    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }
  }, [connectionState]);

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

      {showConnectionHint && (
        <div className="connection-hint" role="alert">
          <p>若遲遲無法連線，請確認：</p>
          <ul>
            <li>已用<strong>另一個瀏覽器</strong>或<strong>無痕視窗</strong>開啟分享連結（同一帳號開兩個分頁無法連線）</li>
            <li>對方也已進入此聊天室畫面</li>
            <li>網路與防火牆允許 WebRTC</li>
          </ul>
        </div>
      )}

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
        {connectionState !== 'connected' && (
          <p className="fallback-notice">目前使用備援連線，訊息經由伺服器傳送</p>
        )}
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="輸入訊息..."
          rows={3}
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim()}
          className="send-button"
        >
          傳送
        </button>
      </div>
    </div>
  );
};

export default ChatPage;
