/**
 * ChatPage 的房間入場前置流程，從頁面初始化 effect 拆出。
 *
 * 職責包含 R11 私有房加入前讀取拒絕、可見房間狀態檢查、本機歷史載入、
 * joinRoom 與加入後伺服器快照。P2P 拓撲初始化仍留在 ChatPage。
 */
import type { NavigateFunction } from 'react-router-dom';
import type { IChatStorage, IRoomService } from '../../ports';
import type { ChatMessage, P2PRoom } from '../../types';
import { logger } from '../../utils/logger';
import { featureLog } from '../../utils/featureLog';

interface PrepareChatRoomEntryOptions {
  roomId: string;
  uid: string;
  roomService: IRoomService;
  chatStorage: IChatStorage;
  isMounted: () => boolean;
  navigate: NavigateFunction;
  setRoomName: (name: string | undefined) => void;
  setIsRoomOwner: (isOwner: boolean) => void;
  setMessagesList: (messages: ChatMessage[]) => void;
  setHasJoinedRoom: (joined: boolean) => void;
}

/** 回傳 true 才能繼續初始化 P2P；false 代表已卸載或已完成導頁。 */
export async function prepareChatRoomEntry({
  roomId,
  uid,
  roomService,
  chatStorage,
  isMounted,
  navigate,
  setRoomName,
  setIsRoomOwner,
  setMessagesList,
  setHasJoinedRoom,
}: PrepareChatRoomEntryOptions): Promise<boolean> {
  // 先讀取可見的房間資訊。R11 的私有房非成員會被 firestore.rules:295
  // 拒絕讀取，此時不能中止，必須讓下方 joinRoom 先取得房籍。
  let room: P2PRoom | null = null;
  let preJoinReadDenied = false;
  try {
    room = await roomService.getRoom(roomId);
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code ?? '';
    if (code !== 'permission-denied' && !code.endsWith('/permission-denied')) throw error;
    preJoinReadDenied = true;
    logger.info('[ChatPage] Pre-join room read denied; continuing with private-room join', {
      roomId, uid,
    });
  }
  if (!isMounted()) return false;
  if (!room && !preJoinReadDenied) {
    logger.warn('[ChatPage] Room not found, navigating to dashboard', { roomId });
    navigate('/dashboard');
    return false;
  }

  if (room) {
    setRoomName(room.roomName);
    setIsRoomOwner(room.ownerUid === uid);
    logger.info('[ChatPage] Room found', {
      roomId,
      status: room.status,
      participants: room.participants.length,
      ownerUid: room.ownerUid,
    });
    if (room.status === 'closed') {
      logger.warn('[ChatPage] Room is closed, navigating to dashboard', { roomId });
      navigate('/dashboard');
      return false;
    }
  }

  // 本機歷史不應依賴 P2P 是否已重新連上。
  try {
    const history = await chatStorage.getChatMessages(roomId);
    if (!isMounted()) return false;
    setMessagesList(history);
  } catch (error) {
    logger.warn('[ChatPage] Failed to load local message history', { roomId, error });
  }

  logger.info('[ChatPage] Calling joinRoom', { roomId, uid });
  try {
    await roomService.joinRoom(roomId, uid);
    if (!isMounted()) return false;
    featureLog('chat', 'room_joined', { roomId, uid });
    logger.info('[ChatPage] joinRoom completed', { roomId, uid });
    setHasJoinedRoom(true);

    // 保留既有同步窗口，再以伺服器快照確認加入後狀態。
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!isMounted()) return false;
    const roomAfterJoin = await roomService.getRoom(roomId, true);
    if (!isMounted()) return false;
    if (!roomAfterJoin) {
      logger.warn('[ChatPage] Room not found after join, navigating to dashboard', { roomId });
      navigate('/dashboard');
      return false;
    }

    // 私有房在加入前不可讀，房名與房主判斷以取得房籍後的 server snapshot 為準。
    setRoomName(roomAfterJoin.roomName);
    setIsRoomOwner(roomAfterJoin.ownerUid === uid);
    if (roomAfterJoin.status === 'closed') {
      logger.warn('[ChatPage] Room closed after join, navigating to dashboard', { roomId });
      navigate('/dashboard');
      return false;
    }
    if (roomAfterJoin.status === 'waiting' && roomAfterJoin.participants.length < 2) {
      logger.info('[ChatPage] Room still waiting after join, navigating to waiting page', {
        roomId,
        participantCount: roomAfterJoin.participants.length,
      });
      navigate(`/waiting/${roomId}`);
      return false;
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '';
    logger.error('[ChatPage] joinRoom failed', { roomId, uid, error: errMsg });
    if (!isMounted()) return false;
    if (errMsg === '房間已關閉') {
      navigate('/dashboard');
      return false;
    }
    throw error;
  }

  return true;
}
