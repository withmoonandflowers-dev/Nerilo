/**
 * 重構後的 ChatPage
 * 使用模組化的 hooks 來管理 P2P 連線、房間訂閱和訊息
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useServices } from '../../contexts/ServicesContext';
import {
  sendMessageViaRelay,
  subscribeToRelayMessages,
} from '../../services/FirestoreChatFallback';
import type { ConnectionState, P2PRoom, ChatMessage } from '../../types';
import { featureLog } from '../../utils/featureLog';
import { logger } from '../../utils/logger';
import { useP2PArchitecture } from './hooks/useP2PArchitecture';
import { useStarTopology } from './hooks/useStarTopology';
import { useMeshTopology } from './hooks/useMeshTopology';
import { useRoomSubscription } from './hooks/useRoomSubscription';
import { useChatMessages } from './hooks/useChatMessages';
import { ConnectionBanner } from '../../components/ConnectionBanner/ConnectionBanner';
import { SkeletonMessages, ConnectingAnimation } from '../../components/Skeleton/Skeleton';
import { formatTimestamp, shouldShowDateSeparator, formatDateSeparator } from '../../utils/formatTimestamp';
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
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initializedRef = useRef(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [roomData, setRoomData] = useState<{ name?: string } | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingRef = useRef(false);
  /** 當前拓撲類型：null=未初始化, 'star'=2人直連, 'mesh'=多人鏈式 */
  const currentTopologyRef = useRef<'star' | 'mesh' | null>(null);
  /** 拓撲初始化/遷移互斥鎖，防止並行 init */
  const migrationInProgressRef = useRef(false);
  const connectingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const architecture = useP2PArchitecture();
  const starTopology = useStarTopology({ chatStorage });
  const meshTopology = useMeshTopology({ chatStorage });
  const roomSubscription = useRoomSubscription({ roomService });
  const { messages, addMessage, addMessages, setMessagesList, updateMessageStatus } = useChatMessages();

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
        logger.info('[ChatPage] init started', { roomId, uid });

        // 1. 檢查房間是否存在
        const room = await roomService.getRoom(roomId);
        if (!isMounted()) return; // guard: cleanup ran while awaiting
        if (!room) {
          logger.warn('[ChatPage] Room not found, navigating to dashboard', { roomId });
          navigate('/dashboard');
          return;
        }
        setRoomData({ name: room.name });

        logger.info('[ChatPage] Room found', {
          roomId,
          status: room.status,
          participants: room.participants.length,
          ownerUid: room.ownerUid,
        });

        // 1b. 從 IndexedDB 載入歷史訊息（使頁面重載後仍可見）
        try {
          const history = await chatStorage.getChatMessages(roomId, 200);
          if (!isMounted()) return;
          if (history.length > 0) {
            addMessages(history);
            logger.info('[ChatPage] Loaded message history from IndexedDB', { roomId, count: history.length });
          }
        } catch (e) {
          logger.warn('[ChatPage] Failed to load message history', e);
        }

        // 2. 檢查房間狀態
        if (room.status === 'closed') {
          logger.warn('[ChatPage] Room is closed, navigating to dashboard', { roomId });
          navigate('/dashboard');
          return;
        }

        // 3. 加入房間
        logger.info('[ChatPage] Calling joinRoom', { roomId, uid });
        try {
          await roomService.joinRoom(roomId, uid);
          if (!isMounted()) return; // guard: cleanup ran during joinRoom (retry loop)
          featureLog('chat', 'room_joined', { roomId, uid });
          logger.info('[ChatPage] joinRoom completed', { roomId, uid });
          setHasJoinedRoom(true);

          // 等待 Firestore 同步更新
          await new Promise(resolve => setTimeout(resolve, 500));
          if (!isMounted()) return;

          // 再次讀取房間狀態
          const roomAfterJoin = await roomService.getRoom(roomId, true);
          if (!isMounted()) return;
          if (!roomAfterJoin) {
            logger.warn('[ChatPage] Room not found after join, navigating to dashboard', { roomId });
            navigate('/dashboard');
            return;
          }

          // 如果房間狀態仍然是 waiting，且參與者數量 < 2，轉到等待頁面
          if (roomAfterJoin.status === 'waiting' && roomAfterJoin.participants.length < 2) {
            logger.info('[ChatPage] Room still waiting after join, navigating to waiting page', {
              roomId,
              participantCount: roomAfterJoin.participants.length,
            });
            navigate(`/waiting/${roomId}`);
            return;
          }
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : '';
          logger.error('[ChatPage] joinRoom failed', { roomId, uid, error: errMsg });
          if (!isMounted()) return;
          if (errMsg === '房間已關閉') {
            navigate('/dashboard');
            return;
          }
          throw error;
        }

        // 4. 初始化 P2P 連線（支援 Star→Mesh 拓撲遷移）
        //
        // 拓撲遷移流程：
        //   - 2 人加入 → Star（直連 DataChannel）
        //   - 第 3 人加入 → onRoomOpen 觸發 → decision 變為 mesh
        //   → cleanup Star → initialize Mesh
        //   → MeshGossipManager 註冊 meshIdentity
        //   → MeshTopologyManager reactive discovery 發現彼此
        //   → 建立全鏈式 P2P (A↔B↔C, gossip relay)
        //
        const initializeP2P = async (room: P2PRoom, effectiveParticipantCount?: number) => {
          // 互斥鎖：防止並行初始化（onRoomOpen + 直接讀取同時觸發）
          if (migrationInProgressRef.current) return;
          migrationInProgressRef.current = true;

          try {
            const effectiveCount = effectiveParticipantCount ?? room.participants.length;
            if (room.status !== 'open' || effectiveCount < 2) return;

            const decision = architecture.decide(room, effectiveCount);
            const currentTopo = currentTopologyRef.current;

            // 同拓撲 → 不需要遷移
            if (currentTopo === decision.type) return;

            featureLog('chat', 'architecture_decided', { roomId, type: decision.type, from: currentTopo });
            logger.info('[ChatPage] P2P topology', {
              roomId, currentTopo, newTopo: decision.type, effectiveCount,
            });

            // ★ MIGRATION: Star → Mesh（第 3 人加入時觸發）
            if (currentTopo === 'star' && decision.type === 'mesh') {
              logger.info('[ChatPage] Migrating Star → Mesh', { roomId, effectiveCount });
              starTopology.cleanup();
              setConnectionState('connecting');
              await meshTopology.initialize(roomId, uid, setConnectionState, addMessage);
              currentTopologyRef.current = 'mesh';
              return;
            }

            // FIRST INIT（currentTopo === null）
            if (currentTopo === null) {
              if (decision.type === 'mesh') {
                logger.info('[ChatPage] Initializing Mesh topology', { roomId, uid, effectiveCount });
                await meshTopology.initialize(roomId, uid, setConnectionState, addMessage);
              } else {
                const isInitiator = room.ownerUid === uid;
                logger.info('[ChatPage] Initializing Star topology', { roomId, uid, isInitiator });
                await starTopology.initialize(roomId, uid, isInitiator, setConnectionState, addMessage);
              }
              currentTopologyRef.current = decision.type;
            }
            // mesh → star: 不降級（避免震盪），保持 mesh 運作
          } catch (error) {
            logger.error('[ChatPage] Error initializing P2P', { roomId, error });
            setConnectionState('failed');
          } finally {
            migrationInProgressRef.current = false;
          }
        };

        if (!isMounted()) return;

        // 5. 訂閱房間變化
        await roomSubscription.subscribe(roomId, {
          onRoomClosed: () => {
            logger.warn('[ChatPage] Room is closed, navigating to dashboard', { roomId });
            navigate('/dashboard');
          },
          onRoomWaiting: () => {
            logger.info('[ChatPage] Room is still waiting, navigating to waiting page', { roomId });
            navigate(`/waiting/${roomId}`);
          },
          onRoomOpen: async (room, effectiveParticipantCount) => {
            logger.info('[ChatPage] Room is open via subscription', {
              roomId,
              effectiveParticipantCount,
            });
            // initializeP2P 內部已有互斥鎖，直接呼叫即可
            await initializeP2P(room, effectiveParticipantCount);
          },
          onRoomNotFound: () => {
            logger.warn('[ChatPage] Room not found, navigating to dashboard', { roomId });
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
            logger.info('[ChatPage] Initial room has', effectiveCount, 'participant(s) but status is open (likely sync delay)', {
              roomId,
            });
            effectiveCount = 2;
          }

          if (effectiveCount >= 2) {
            await initializeP2P(initialRoom, effectiveCount);
          }
        }
      } catch (error) {
        logger.error('[ChatPage] Error initializing chat:', error);
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
        roomService.leaveRoom(roomId, user.uid).catch((err) => logger.error('[ChatPage] leaveRoom failed', err));
      }

      // 清除 StrictMode 防重入旗標，讓 re-mount（開發模式下的雙重渲染）能正常重新初始化
      if (initKey) {
        const w = window as unknown as Record<string, Record<string, boolean>>;
        if (w.__neriloChatInitRooms) {
          delete w.__neriloChatInitRooms[initKey];
        }
      }

      initializedRef.current = false;
      currentTopologyRef.current = null;
      migrationInProgressRef.current = false;
    };
  }, [user, roomId, navigate, roomService, architecture, starTopology, meshTopology, roomSubscription, addMessage, setMessagesList]);

  // Firestore 備援：訂閱房間訊息，P2P 未連線時對方經 Firestore 送的訊息也能顯示
  // 必須等 joinRoom 完成後才啟動，否則第三人（尚未在 participants 中）會觸發 permission-denied
  useEffect(() => {
    if (!roomId || !user || !hasJoinedRoom) return;
    const unsubscribe = subscribeToRelayMessages(roomId, addMessage, user?.uid);
    return () => unsubscribe();
  }, [roomId, user, addMessage, hasJoinedRoom]);

  // Scroll detection: track if user is near bottom
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 120; // px from bottom
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    setIsNearBottom(nearBottom);
    if (nearBottom) setNewMessageCount(0);
  }, []);

  // Auto-scroll when near bottom; otherwise increment new message count
  useEffect(() => {
    if (isNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (messages.length > 0) {
      // Check if the last message is from someone else
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.from !== user?.uid) {
        setNewMessageCount((prev) => prev + 1);
      }
    }
  }, [messages, isNearBottom, user?.uid]);

  const sendMessage = async (content: string, existingMessageId?: string) => {
    if (!user || !roomId) return;

    // Create a temporary message with 'sending' status
    const tempId = existingMessageId || `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!existingMessageId) {
      const pendingMessage: ChatMessage = {
        messageId: tempId,
        from: user.uid,
        content,
        timestamp: Date.now(),
        deliveryStatus: 'sending',
      };
      addMessage(pendingMessage);
    } else {
      updateMessageStatus(tempId, 'sending');
    }

    try {
      if (connectionState === 'connected') {
        if (architecture.isMesh()) {
          await meshTopology.sendMessage(content);
          featureLog('chat', 'message_sent', { roomId, channel: 'p2p_mesh' });
        } else if (architecture.isStar()) {
          await starTopology.sendMessage(content);
          featureLog('chat', 'message_sent', { roomId, channel: 'p2p_star' });
        } else {
          logger.warn('[ChatPage] No chat service available');
          updateMessageStatus(tempId, 'failed');
          return;
        }
      } else {
        await sendMessageViaRelay(roomId, user.uid, content);
        featureLog('chat', 'message_sent', { roomId, channel: 'firestore_fallback' });
      }
      updateMessageStatus(tempId, 'sent');
      // Mark as delivered after a short delay (simulates P2P ack)
      setTimeout(() => updateMessageStatus(tempId, 'delivered'), 1500);
    } catch (error) {
      logger.error('[ChatPage] Error sending message:', error);
      updateMessageStatus(tempId, 'failed');
    }
  };

  const handleSend = async () => {
    if (!inputValue.trim() || !user || !roomId) return;
    const content = inputValue.trim();
    setInputValue('');
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    // Stop typing indicator
    emitTyping(false);
    if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    await sendMessage(content);
  };

  const handleResend = (messageId: string, content: string) => {
    sendMessage(content, messageId);
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

  // Textarea auto-grow (max 4 lines) + typing indicator
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 20;
      const maxHeight = lineHeight * 4 + 24; // 4 lines + padding
      ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    }

    // Emit typing event (debounced stop)
    if (e.target.value.trim()) {
      emitTyping(true);
      if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
      typingDebounceRef.current = setTimeout(() => emitTyping(false), 2000);
    } else {
      emitTyping(false);
      if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    }
  };

  // Typing indicator: subscribe to remote typing events
  useEffect(() => {
    if (connectionState !== 'connected') return;
    const topo = currentTopologyRef.current;
    if (topo !== 'star') return; // Typing only supported on star topology for now

    const unsubscribe = starTopology.onTyping((data) => {
      if (data.userId === user?.uid) return; // Ignore own typing
      setRemoteTyping(data.isTyping);
      // Auto-clear after 3 seconds if no "stopped typing" event
      if (data.isTyping) {
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setRemoteTyping(false), 3000);
      }
    });

    return () => {
      unsubscribe();
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [connectionState, starTopology, user?.uid]);

  // Debounced local typing: send typing event via DataChannel
  const emitTyping = useCallback((isTyping: boolean) => {
    if (connectionState !== 'connected') return;
    const topo = currentTopologyRef.current;
    if (topo !== 'star') return;

    if (isTyping && !localTypingRef.current) {
      localTypingRef.current = true;
      starTopology.sendTyping(true);
    } else if (!isTyping && localTypingRef.current) {
      localTypingRef.current = false;
      starTopology.sendTyping(false);
    }
  }, [connectionState, starTopology]);

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

  const getConnectionMode = (): string | null => {
    if (connectionState !== 'connected') {
      return connectionState === 'idle' ? null : 'firestore';
    }
    const topo = currentTopologyRef.current;
    if (topo === 'mesh') return 'p2p_mesh';
    if (topo === 'star') return 'p2p_star';
    return null;
  };

  const handleReconnect = () => {
    // Soft reconnect: reset init guard and re-trigger P2P initialization
    // Messages are preserved in memory + IndexedDB
    initializedRef.current = false;
    if (initKey) {
      const w = window as unknown as Record<string, Record<string, boolean>>;
      if (w.__neriloChatInitRooms) {
        delete w.__neriloChatInitRooms[initKey];
      }
    }
    setConnectionState('connecting');
    // Force re-mount of the effect by navigating to same page
    navigate(`/chat/${roomId}`, { replace: true });
  };

  return (
    <div className="chat-page" id="main-content">
      <header className="chat-header" role="banner">
        <div className="header-left">
          <button onClick={handleLeaveRoom} className="btn-back" aria-label="返回儀表板">
            ← 返回
          </button>
          <h2>{roomData?.name || `聊天室 ${roomId?.substring(0, 8)}`}</h2>
        </div>
        {connectionState === 'connected' && (
          <div className="header-right">
            <span className="encryption-badge" title="端對端加密 (AES-256-GCM)" aria-label="端對端加密已啟用">
              &#x1F512; E2EE
            </span>
          </div>
        )}
      </header>

      <ConnectionBanner
        connectionState={connectionState}
        mode={getConnectionMode()}
        onReconnect={handleReconnect}
      />

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

      <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll} role="log" aria-label="聊天訊息" aria-live="polite">
        {messages.length === 0 && connectionState === 'connecting' && (
          <ConnectingAnimation text="正在建立 P2P 連線..." />
        )}
        {messages.length === 0 && connectionState === 'idle' && (
          <SkeletonMessages />
        )}
        {messages.length === 0 && connectionState === 'connected' && (
          <div className="empty-chat-state" role="status">
            <p>&#x1F512; 已建立安全連線</p>
            <p>發送訊息開始聊天吧！</p>
          </div>
        )}
        {messages.map((msg, index) => {
          const isOwn = msg.from.startsWith(user?.uid || '');
          const prevMsg = index > 0 ? messages[index - 1] : null;
          const showDateSep = !prevMsg || shouldShowDateSeparator(prevMsg.timestamp, msg.timestamp);
          return (
            <React.Fragment key={msg.messageId}>
              {showDateSep && (
                <div className="date-separator" aria-label={formatDateSeparator(msg.timestamp)}>
                  <span>{formatDateSeparator(msg.timestamp)}</span>
                </div>
              )}
              <div className={`message ${isOwn ? 'own' : 'other'}`}>
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
                <div className="message-meta">
                  <span className="message-time">
                    {formatTimestamp(msg.timestamp)}
                  </span>
                  {isOwn && msg.deliveryStatus && (
                    <span className={`delivery-status ${msg.deliveryStatus}`} aria-label={
                      msg.deliveryStatus === 'sending' ? '傳送中' :
                      msg.deliveryStatus === 'sent' ? '已傳送' :
                      msg.deliveryStatus === 'delivered' ? '已送達' : '傳送失敗'
                    }>
                      {msg.deliveryStatus === 'sending' && <span className="status-icon sending" aria-hidden="true">&#x23F3;</span>}
                      {msg.deliveryStatus === 'sent' && <span className="status-icon sent" aria-hidden="true">&#x2713;</span>}
                      {msg.deliveryStatus === 'delivered' && <span className="status-icon delivered" aria-hidden="true">&#x2713;&#x2713;</span>}
                      {msg.deliveryStatus === 'failed' && (
                        <>
                          <span className="status-icon failed" aria-hidden="true">&#x26A0;</span>
                          <button
                            className="btn-resend"
                            onClick={() => handleResend(msg.messageId, msg.content)}
                          >
                            重新傳送
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}

        {/* Typing indicator */}
        {remoteTyping && (
          <div className="message other typing-indicator-wrapper">
            <div className="message-content typing-bubble">
              <span className="typing-dots" aria-label="對方正在輸入">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />

        {/* New message hint */}
        {!isNearBottom && newMessageCount > 0 && (
          <button
            className="new-message-hint"
            onClick={() => {
              messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
              setNewMessageCount(0);
            }}
            aria-label={`${newMessageCount} 則新訊息`}
          >
            ↓ {newMessageCount} 則新訊息
          </button>
        )}
      </div>

      <div className="chat-input-area">
        {connectionState !== 'connected' && (
          <p className="fallback-notice">目前使用備援連線，訊息經由伺服器傳送</p>
        )}
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="輸入訊息..."
          rows={1}
          aria-label="輸入訊息，Enter 傳送，Shift+Enter 換行"
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim()}
          className="send-button"
          aria-label="傳送訊息"
        >
          傳送
        </button>
      </div>
    </div>
  );
};

export default ChatPage;
