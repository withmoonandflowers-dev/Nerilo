/**
 * 重構後的 ChatPage
 * 使用模組化的 hooks 來管理 P2P 連線、房間訂閱和訊息
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  IconPhone,
  IconVideo,
  IconPhoneOff,
  IconPhoneIncoming,
  IconMicrophone,
  IconMicrophoneOff,
  IconVideoOff,
  IconPaperclip,
  IconFile,
  IconDownload,
  IconX,
} from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { useServices } from '../../contexts/ServicesContext';
import {
  sendMessageViaFirestore,
  subscribeToFirestoreMessages,
} from '../../services/FirestoreChatFallback';
import type { ConnectionState, P2PRoom, ChatMessage } from '../../types';
import { featureLog } from '../../utils/featureLog';
import { logger } from '../../utils/logger';
import { generateUUID } from '../../utils/uuid';
import { startRoomHeartbeat } from '../../services/RoomHeartbeat';
import { creditEconomy } from '../../core/incentive/CreditEconomy';
import { useP2PArchitecture } from './hooks/useP2PArchitecture';
import { useStarTopology } from './hooks/useStarTopology';
import { useMeshTopology } from './hooks/useMeshTopology';
import { useE2eeMode, useProtocolMismatch } from './hooks/useChatIndicators';
import { useRoomSubscription } from './hooks/useRoomSubscription';
import { useChatMessages } from './hooks/useChatMessages';
import { useMediaCall, type CallType } from './hooks/useMediaCall';
import { useFileTransfer, type ReceivedFile } from './hooks/useFileTransfer';
import { ConnectionBanner } from '../../components/ConnectionBanner/ConnectionBanner';
import { ConnectionProgress } from '../../components/ConnectionProgress/ConnectionProgress';
import { ConnectionGlobe } from '../../components/ConnectionGlobe/ConnectionGlobe';
import { usePeerGlobe } from '../../hooks/usePeerGlobe';
import { SkeletonMessages } from '../../components/Skeleton/Skeleton';
import { formatTimestamp, shouldShowDateSeparator, formatDateSeparator } from '../../utils/formatTimestamp';
import { roomDisplayName } from '../../utils/roomDisplayName';
import { TicTacToePanel } from '../game/TicTacToePanel';
import './ChatPage.css';

// ── Helpers ───────────────────────────────────────────────────────────────
function formatCallDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isImageMime(type: string): boolean {
  return type.startsWith('image/');
}

const ChatPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const { roomService, chatStorage } = useServices();
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [showConnectionHint, setShowConnectionHint] = useState(false);
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
  const [showFirstMsgCoach, setShowFirstMsgCoach] = useState(false);
  const [showGame, setShowGame] = useState(false);
  const [roomName, setRoomName] = useState<string | undefined>(undefined);
  // 是否為房主（host migration 易主時經 onRoomOpen 更新）——房主負責活性心跳
  const [isRoomOwner, setIsRoomOwner] = useState(false);
  /** 遞增即觸發 init effect 重跑（優雅重連，保留訊息歷史，取代整頁 reload） */
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initializedRef = useRef(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTypingRef = useRef(false);
  /** 當前拓撲類型：null=未初始化, 'star'=2人直連, 'mesh'=多人鏈式 */
  const currentTopologyRef = useRef<'star' | 'mesh' | null>(null);
  /** 拓撲初始化/遷移互斥鎖，防止並行 init */
  const migrationInProgressRef = useRef(false);
  /** 房間文件的最新參與者數（真相來源）。備援橋接條件用它，不用 mesh 層
   *  的鄰居發現數——後者在對方 mesh init 卡住時會少算，導致該橋不橋。 */
  const participantCountRef = useRef(0);
  const connectingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const architecture = useP2PArchitecture();
  const starTopology = useStarTopology({ chatStorage });
  const meshTopology = useMeshTopology({ chatStorage });
  const roomSubscription = useRoomSubscription({ roomService });
  const { messages, addMessage, setMessagesList, updateMessageStatus } = useChatMessages();

  // Derive media + file services from the active star P2PManager. These are
  // null while connecting / when on mesh topology / when on fallback; the
  // call and paperclip buttons are disabled in those states.
  const p2pManager = starTopology.getState().p2pManager;
  const mediaService = p2pManager?.getMediaService() ?? null;
  const channelBus = p2pManager?.getChannelBus() ?? null;
  const fileTransferService = p2pManager?.getFileTransferService() ?? null;
  const deviceId = p2pManager?.getDeviceId() ?? '';

  // 連線地球：連上後經 presence 交換近似位置（時區），畫在連線畫面
  const globePoints = usePeerGlobe(channelBus, connectionState === 'connected', user?.uid ?? '');
  const localId = user ? `${user.uid}/${deviceId || 'na'}` : '';

  const mediaCall = useMediaCall({ mediaService, channelBus, localId });
  const fileTransfer = useFileTransfer({ fileTransferService });

  // File preview / selection (before sending)
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!pendingFile) {
      setPendingPreviewUrl(null);
      return;
    }
    if (isImageMime(pendingFile.type)) {
      const url = URL.createObjectURL(pendingFile);
      setPendingPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPendingPreviewUrl(null);
    }
  }, [pendingFile]);

  // Local + remote stream attachment to <video> elements.
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = mediaCall.localStream;
  }, [mediaCall.localStream]);
  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = mediaCall.remoteStream;
  }, [mediaCall.remoteStream]);

  const canCall = mediaService !== null && channelBus !== null && mediaCall.state === 'idle';

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

        setRoomName(room.roomName);
        setIsRoomOwner(room.ownerUid === uid);

        logger.info('[ChatPage] Room found', {
          roomId,
          status: room.status,
          participants: room.participants.length,
          ownerUid: room.ownerUid,
        });

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
            participantCountRef.current = Math.max(participantCountRef.current, effectiveCount);
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
            // 房主可能因 host migration 易主：跟著 snapshot 更新，心跳隨之交接
            setIsRoomOwner(room.ownerUid === uid);
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
  }, [user, roomId, navigate, roomService, architecture, starTopology, meshTopology, roomSubscription, addMessage, setMessagesList, reconnectNonce]);

  // Firestore 備援：訂閱房間訊息，P2P 未連線時對方經 Firestore 送的訊息也能顯示
  // 必須等 joinRoom 完成後才啟動，否則第三人（尚未在 participants 中）會觸發 permission-denied
  useEffect(() => {
    if (!roomId || !user || !hasJoinedRoom) return;
    const unsubscribe = subscribeToFirestoreMessages(roomId, addMessage, {
      localUid: user.uid,
      // 到訊當下再解析 chatService，金鑰交換完成後即可解密
      decrypt: (payload, senderId) => {
        const chatService = starTopology.getState().chatService;
        if (!chatService) {
          return Promise.reject(new Error('ChatService not ready'));
        }
        return chatService.decryptFromFallback(payload, senderId);
      },
    });
    return () => unsubscribe();
  }, [roomId, user, addMessage, hasJoinedRoom, starTopology]);

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

  // 點數經濟（ADR-0020）：實際連線中 = 在線貢獻網路容量 = 累積點數。
  // 綁 connected 狀態而非開著分頁，降低純掛機刷點。斷線/離開自動停。
  useEffect(() => {
    if (!user?.uid || connectionState !== 'connected') return;
    creditEconomy.init(user.uid);
    creditEconomy.startEarning();
    return () => creditEconomy.stopEarning();
  }, [user?.uid, connectionState]);

  // 房主活性心跳：在房內且是房主時每 5 分鐘刷新 lastActiveAt/ttlExpireAt。
  // 活房 TTL 永遠在未來（不被原生 TTL 誤殺）；全員斷線 → 心跳停 → 30 分鐘內
  // 過期 → 公開列表以 ttlExpireAt 濾掉殭屍房。易主時此 effect 自動交接。
  useEffect(() => {
    if (!isRoomOwner || !roomId) return;
    const stop = startRoomHeartbeat(roomId);
    return stop;
  }, [isRoomOwner, roomId]);

  const sendMessage = async (content: string, existingMessageId?: string) => {
    if (!user || !roomId) return;

    // 產生「真正的」訊息 id 並貫穿樂觀顯示 → 服務送出 → 本機自我 emit，三者共用同一 id，
    // 使 useChatMessages 的 id 去重能收斂成一則（修掉寄件方自我重複）。
    const tempId = existingMessageId || generateUUID();
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
          await meshTopology.sendMessage(content, tempId);
          featureLog('chat', 'message_sent', { roomId, channel: 'p2p_mesh' });
          // 混合模式橋接：mesh 連上的鄰居數 < 房間應到人數-1，代表有成員在
          // mesh 之外（掉 Firestore 備援或 init 卡住）。同則訊息（同 id）雙寫
          // 備援讓掉隊者收到；mesh 成員收到兩份同 id 由 useChatMessages 去重
          // → 仍恰好一次。人數以「房間文件」為真相來源（join 即入列），
          // 不用 mesh 鄰居發現數（對方 mesh init 卡住時會少算）。
          const coverage = meshTopology.getState().meshChatService?.getMeshCoverage();
          const expectedPeers = participantCountRef.current - 1;
          if (coverage && expectedPeers > 0 && coverage.connected < expectedPeers) {
            await sendMessageViaFirestore(roomId, user.uid, { content }, tempId);
            featureLog('chat', 'message_sent', { roomId, channel: 'firestore_bridge' });
          }
        } else if (architecture.isStar()) {
          await starTopology.sendMessage(content, tempId);
          featureLog('chat', 'message_sent', { roomId, channel: 'p2p_star' });
        } else {
          logger.warn('[ChatPage] No chat service available');
          updateMessageStatus(tempId, 'failed');
          return;
        }
      } else {
        if (architecture.isStar()) {
          // ADR-0004：星型房的備援一律密文；金鑰未就緒時擲錯（訊息標記失敗、可重送），
          // 不得默默降級明文
          const chatService = starTopology.getState().chatService;
          if (!chatService) {
            throw new Error('E2EE 金鑰尚未建立（P2P 交換未完成），無法經備援通道傳送');
          }
          const encrypted = await chatService.encryptForFallback(content);
          await sendMessageViaFirestore(roomId, user.uid, { encrypted }, tempId);
        } else {
          // mesh 房間尚未支援 E2EE（誠實標示於 UI），備援維持明文
          await sendMessageViaFirestore(roomId, user.uid, { content }, tempId);
        }
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

  // Onboarding Phase 2：第一則訊息 coachmark。
  // 首次連上線且尚無訊息時，提示「端對端加密」這個賣點（每瀏覽器只顯示一次）。
  useEffect(() => {
    if (connectionState !== 'connected' || messages.length > 0) return;
    try {
      if (!localStorage.getItem('nerilo_first_msg_coach')) {
        setShowFirstMsgCoach(true);
        localStorage.setItem('nerilo_first_msg_coach', '1');
        featureLog('onboarding', 'first_message_coachmark_shown', { roomId });
      }
    } catch {
      // localStorage 不可用時略過
    }
  }, [connectionState, messages.length, roomId]);

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
    // 優雅重連：重置連線狀態並遞增 nonce，觸發 init effect 的 cleanup→re-run，
    // 重建 P2P 連線但保留已收到的訊息歷史（取代整頁 window.location.reload）。
    featureLog('chat', 'manual_reconnect', { roomId });
    setConnectionState('idle');
    currentTopologyRef.current = null;
    setReconnectNonce((n) => n + 1);
  };

  // 指示器邏輯抽出於 useChatIndicators（E2EE 狀態＋Spec 009 協議版本不合）
  const e2eeMode = useE2eeMode({
    isMesh: architecture.isMesh(),
    starChatService: starTopology.getState().chatService,
    connectionState,
    connectionMode: getConnectionMode(),
  });
  const protocolMismatch = useProtocolMismatch(
    () => meshTopology.getState().meshChatService,
    reconnectNonce
  );

  const handleStartCall = async (type: CallType) => {
    try {
      await mediaCall.startCall(type);
    } catch (err) {
      logger.error('[ChatPage] startCall failed', err);
    }
  };

  return (
    <div className="chat-page" id="main-content">
      <header className="chat-header" role="banner">
        <div className="header-left">
          <button onClick={handleLeaveRoom} className="btn-back" aria-label="返回儀表板">
            ← 返回
          </button>
          <h2>{roomDisplayName({ roomName, roomId })}</h2>
          {e2eeMode === 'p2p' && (
            <span
              className="e2ee-indicator e2ee-indicator-p2p"
              role="status"
              aria-label="端到端加密已啟用"
              title="訊息以 AES-256-GCM 加密，僅房間成員可解讀。詳見 docs/THREAT_MODEL.md。"
            >
              <span aria-hidden="true">🔒</span> 端到端加密
            </span>
          )}
          {e2eeMode === 'fallback' && (
            <span
              className="e2ee-indicator e2ee-indicator-fallback"
              role="status"
              aria-label="備援模式：訊息仍以端到端金鑰加密，但透過伺服器中繼"
              title="P2P 未連線；訊息經由 Firestore 中繼，但內容仍以同一把 sender key 加密。"
            >
              <span aria-hidden="true">🔓</span> 備援模式（加密傳輸中）
            </span>
          )}
          {e2eeMode === 'exchanging' && (
            <span
              className="e2ee-indicator e2ee-indicator-exchanging"
              role="status"
              aria-label="端到端加密金鑰交換中"
              title="正在與對方交換加密金鑰；完成前訊息會暫緩送出，不會以明文傳送。"
            >
              <span aria-hidden="true">🔑</span> 金鑰交換中…
            </span>
          )}
          {e2eeMode === 'mesh-dtls' && (
            <span
              className="e2ee-indicator e2ee-indicator-dtls"
              role="status"
              aria-label="傳輸層加密（非端到端加密）"
              title="多人房間目前僅有 WebRTC 傳輸層加密（DTLS）；端到端加密尚未支援多人拓撲。"
            >
              <span aria-hidden="true">🛡️</span> 傳輸加密（非端到端）
            </span>
          )}
        </div>
        <div className="header-right">
          <button
            type="button"
            className="btn-call"
            onClick={() => handleStartCall('audio')}
            disabled={!canCall}
            aria-label="撥打語音通話"
            title={canCall ? '撥打語音通話' : '需要 P2P 連線才能通話'}
          >
            <IconPhone size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn-call"
            onClick={() => handleStartCall('video')}
            disabled={!canCall}
            aria-label="撥打視訊通話"
            title={canCall ? '撥打視訊通話' : '需要 P2P 連線才能通話'}
          >
            <IconVideo size={20} aria-hidden="true" />
          </button>
          {/* 遊戲 demo（里程碑 1）：2 人星型房限定；遊戲事件走 P2P bus ns:'ttt' */}
          {architecture.isStar() && (
            <button
              type="button"
              className="btn-call"
              onClick={() => setShowGame((v) => !v)}
              aria-label="開啟遊戲"
              title="井字棋（P2P 傳輸 demo）"
            >
              <span aria-hidden="true">🎮</span>
            </button>
          )}
        </div>
      </header>

      {/* 井字棋面板：斷線時面板自行顯示「對局暫停」（遊戲不走 Firestore 備援） */}
      {showGame && architecture.isStar() && user && (
        <div className="game-panel-float">
          <TicTacToePanel
            bus={starTopology.getState().p2pManager?.getChannelBus() ?? null}
            isInitiator={isRoomOwner}
            selfId={user.uid}
            connected={connectionState === 'connected'}
            onClose={() => setShowGame(false)}
          />
        </div>
      )}

      {/* Spec 009：gossip 協議版本不合（不靜默降級，fail-visible 提示） */}
      {protocolMismatch && (
        <div className="incoming-call-banner" role="alert" aria-live="assertive">
          <div className="incoming-call-info">
            <span aria-hidden="true">⚠️</span>
            <span>房內有版本不相容的成員，訊息無法互通。請雙方更新到最新版後重新整理。</span>
          </div>
        </div>
      )}

      {/* Incoming call banner */}
      {mediaCall.state === 'ringing' && (
        <div className="incoming-call-banner" role="alert" aria-live="assertive">
          <div className="incoming-call-info">
            <IconPhoneIncoming size={20} aria-hidden="true" />
            <span>來電：{mediaCall.callType === 'video' ? '視訊通話' : '語音通話'}</span>
          </div>
          <div className="incoming-call-actions">
            <button
              type="button"
              className="btn-call-decline"
              onClick={() => mediaCall.declineCall()}
              aria-label="拒絕來電"
            >
              拒絕
            </button>
            <button
              type="button"
              className="btn-call-accept"
              onClick={() => mediaCall.answerCall().catch((err) => logger.error('[ChatPage] answerCall failed', err))}
              aria-label="接聽來電"
            >
              接聽
            </button>
          </div>
        </div>
      )}

      {/* Outgoing-call (ringing remote) status */}
      {mediaCall.state === 'requesting' && (
        <div className="incoming-call-banner outgoing" role="status">
          <div className="incoming-call-info">
            <IconPhone size={20} aria-hidden="true" />
            <span>正在呼叫對方…</span>
          </div>
          <button
            type="button"
            className="btn-call-decline"
            onClick={() => mediaCall.endCall()}
            aria-label="取消呼叫"
          >
            取消
          </button>
        </div>
      )}

      {/* Active call overlay */}
      {mediaCall.state === 'connected' && (
        <div
          className={`call-overlay ${mediaCall.callType === 'video' ? 'video-call' : 'audio-call'}`}
          role="dialog"
          aria-modal="true"
          aria-label={mediaCall.callType === 'video' ? '視訊通話中' : '語音通話中'}
        >
          <div className="call-remote">
            {mediaCall.callType === 'video' ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                aria-label="對方畫面"
              />
            ) : (
              <div className="audio-call-avatar" aria-hidden="true">
                <IconPhone size={64} />
              </div>
            )}
            <div className="call-duration" aria-live="polite">
              {formatCallDuration(mediaCall.callDurationMs)}
            </div>
          </div>
          {mediaCall.callType === 'video' && (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="call-local-preview"
              aria-label="本地預覽"
            />
          )}
          <div className="call-controls">
            <button
              type="button"
              className={`call-control ${mediaCall.audioMuted ? 'active' : ''}`}
              onClick={mediaCall.toggleMute}
              aria-label={mediaCall.audioMuted ? '取消靜音' : '靜音'}
              aria-pressed={mediaCall.audioMuted}
            >
              {mediaCall.audioMuted ? <IconMicrophoneOff size={24} /> : <IconMicrophone size={24} />}
            </button>
            {mediaCall.callType === 'video' && (
              <button
                type="button"
                className={`call-control ${mediaCall.videoMuted ? 'active' : ''}`}
                onClick={mediaCall.toggleCamera}
                aria-label={mediaCall.videoMuted ? '開啟鏡頭' : '關閉鏡頭'}
                aria-pressed={mediaCall.videoMuted}
              >
                {mediaCall.videoMuted ? <IconVideoOff size={24} /> : <IconVideo size={24} />}
              </button>
            )}
            <button
              type="button"
              className="call-control call-end"
              onClick={() => mediaCall.endCall()}
              aria-label="掛斷通話"
            >
              <IconPhoneOff size={24} />
            </button>
          </div>
        </div>
      )}

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
          <ConnectionProgress state={connectionState} />
        )}
        {messages.length === 0 && connectionState === 'idle' && (
          <SkeletonMessages />
        )}
        {messages.length === 0 && connectionState === 'connected' && (
          <div className="connection-welcome">
            <ConnectionGlobe points={globePoints} size={220} />
            <p className="connection-welcome-title">
              {globePoints.length > 1
                ? `已與 ${globePoints.length - 1} 位夥伴跨地連線`
                : '已連線，等待夥伴出現在地球上…'}
            </p>
            {showFirstMsgCoach && (
              <div className="first-msg-coach" role="status">
                <span className="first-msg-coach-icon" aria-hidden="true">🔒</span>
                <p>你們的訊息端對端加密，連我們也看不到。傳出第一則試試。</p>
              </div>
            )}
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

        {/* Received-file cards — rendered after text messages, before typing indicator */}
        {fileTransfer.receivedFiles.map((received: ReceivedFile) => (
          <div key={`file-${received.fileId}`} className="message other file-message">
            <div className="message-content">
              {isImageMime(received.fileType) ? (
                <a
                  href={received.objectUrl}
                  download={received.file.name}
                  className="file-card image"
                  aria-label={`下載圖片 ${received.file.name}`}
                >
                  <img src={received.objectUrl} alt={received.file.name} />
                  <div className="file-card-meta">
                    <span className="file-name">{received.file.name}</span>
                    <span className="file-size">{formatFileSize(received.file.size)}</span>
                  </div>
                </a>
              ) : (
                <a
                  href={received.objectUrl}
                  download={received.file.name}
                  className="file-card"
                  aria-label={`下載檔案 ${received.file.name}`}
                >
                  <IconFile size={32} aria-hidden="true" />
                  <div className="file-card-meta">
                    <span className="file-name">{received.file.name}</span>
                    <span className="file-size">{formatFileSize(received.file.size)}</span>
                  </div>
                  <IconDownload size={20} aria-hidden="true" />
                </a>
              )}
            </div>
            <div className="message-meta">
              <span className="message-time">{formatTimestamp(received.receivedAt)}</span>
            </div>
          </div>
        ))}

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

        {/* In-flight transfers */}
        {fileTransfer.transfers.length > 0 && (
          <div className="transfer-list" role="list" aria-label="檔案傳輸中">
            {fileTransfer.transfers.map((t) => (
              <div key={t.fileId} className={`transfer-item ${t.status}`} role="listitem">
                <IconFile size={20} aria-hidden="true" />
                <div className="transfer-meta">
                  <span className="transfer-name">
                    {t.direction === 'send' ? '傳送中：' : '接收中：'}
                    {t.fileName}
                  </span>
                  <span className="transfer-progress">
                    {formatFileSize(t.bytesTransferred)} / {formatFileSize(t.totalBytes)}
                    {' · '}
                    {Math.round(t.percentage)}%
                  </span>
                </div>
                <div
                  className="transfer-bar"
                  role="progressbar"
                  aria-valuenow={Math.round(t.percentage)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${t.fileName} 傳輸進度 ${Math.round(t.percentage)}%`}
                >
                  <div className="transfer-bar-fill" style={{ width: `${t.percentage}%` }} />
                </div>
                {t.direction === 'send' && t.status === 'transferring' && (
                  <button
                    type="button"
                    className="transfer-cancel"
                    onClick={() => fileTransfer.cancelTransfer(t.fileId)}
                    aria-label="取消傳輸"
                  >
                    <IconX size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* File preview (before sending) */}
        {pendingFile && (
          <div className="pending-file-preview" role="region" aria-label="準備傳送的檔案">
            {pendingPreviewUrl ? (
              <img src={pendingPreviewUrl} alt={pendingFile.name} className="pending-file-image" />
            ) : (
              <IconFile size={32} aria-hidden="true" />
            )}
            <div className="pending-file-meta">
              <span className="file-name">{pendingFile.name}</span>
              <span className="file-size">{formatFileSize(pendingFile.size)}</span>
            </div>
            <button
              type="button"
              className="pending-file-cancel"
              onClick={() => setPendingFile(null)}
              aria-label="取消傳送此檔案"
            >
              <IconX size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="pending-file-send"
              onClick={async () => {
                if (!pendingFile || !fileTransfer.isReady) return;
                try {
                  await fileTransfer.sendFile(pendingFile);
                } catch (err) {
                  logger.error('[ChatPage] sendFile failed', err);
                } finally {
                  setPendingFile(null);
                }
              }}
              disabled={!fileTransfer.isReady}
            >
              傳送檔案
            </button>
          </div>
        )}

        <div className="chat-input-row">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setPendingFile(file);
              e.target.value = ''; // allow re-selecting the same file
            }}
          />
          <button
            type="button"
            className="btn-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={!fileTransfer.isReady}
            aria-label="附加檔案"
            title={fileTransfer.isReady ? '附加檔案' : '需要 P2P 連線才能傳檔'}
          >
            <IconPaperclip size={20} aria-hidden="true" />
          </button>
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
    </div>
  );
};

export default ChatPage;
