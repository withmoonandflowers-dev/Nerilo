/**
 * 房間訂閱管理 Hook
 * 處理房間狀態變化、參與者數量追蹤、Firestore 同步延遲等問題
 * 依賴注入 IRoomService，利於解耦與測試。
 */

import { useRef, useCallback, useMemo } from 'react';
import { logger } from '@/utils/logger';
import type { IRoomService } from '../../../ports';
import type { P2PRoom } from '../../../types';

export interface RoomSubscriptionCallbacks {
  onRoomClosed: () => void;
  onRoomWaiting: (room: P2PRoom) => void;
  onRoomOpen: (room: P2PRoom, effectiveParticipantCount: number) => void;
  onRoomNotFound: () => void;
}

export interface UseRoomSubscriptionOptions {
  roomService: IRoomService;
}

/**
 * Hook 用於管理房間訂閱和參與者數量追蹤
 * @param options.roomService 房間服務（由 ServicesContext 或測試 Mock 注入）
 */
export function useRoomSubscription(options: UseRoomSubscriptionOptions) {
  const { roomService } = options;
  const lastParticipantCountRef = useRef<number>(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const calculateEffectiveParticipantCount = useCallback(
    async (
      room: P2PRoom,
      roomId: string
    ): Promise<number> => {
      const currentCount = room.participants.length;
      const lastCount = lastParticipantCountRef.current;

      if (room.status === 'open' && lastCount >= 2 && currentCount < lastCount && lastCount > 0) {
        logger.warn('[useRoomSubscription] Participant count decreased, forcing server read', {
          roomId,
          cachedCount: currentCount,
          lastCount,
        });
        const serverRoom = await roomService.getRoom(roomId, true);
        if (serverRoom && serverRoom.participants.length !== currentCount) {
          const serverCount = serverRoom.participants.length;
          const effective = room.status === 'open' && serverCount < 2 ? 2 : serverCount;
          logger.info('[useRoomSubscription] Server room data differs, using server data', {
            roomId,
            cachedCount: currentCount,
            serverCount,
            effective,
          });
          lastParticipantCountRef.current = effective;
          return effective;
        }
      }

      if (room.status === 'open' && currentCount < 2) {
        logger.info('[useRoomSubscription] Room has', currentCount, 'participant(s) but status is open (likely sync delay)', {
          roomId,
        });
        lastParticipantCountRef.current = 2;
        return 2;
      }

      if (currentCount > lastCount) {
        lastParticipantCountRef.current = currentCount;
      } else if (lastCount === 0) {
        lastParticipantCountRef.current = currentCount;
      }

      return currentCount;
    },
    [roomService]
  );

  const subscribe = useCallback(
    async (
      roomId: string,
      callbacks: RoomSubscriptionCallbacks
    ): Promise<void> => {
      const initialRoom = await roomService.getRoom(roomId, true);
      if (!initialRoom) {
        callbacks.onRoomNotFound();
        return;
      }

      lastParticipantCountRef.current = initialRoom.participants.length;

      if (initialRoom.status === 'open' && initialRoom.participants.length === 1) {
        lastParticipantCountRef.current = 2;
      }

      unsubscribeRef.current = roomService.subscribeRoom(roomId, async (updatedRoom) => {
        if (!updatedRoom) {
          callbacks.onRoomNotFound();
          return;
        }

        logger.info('[useRoomSubscription] Room updated via subscription', {
          roomId,
          status: updatedRoom.status,
          participants: updatedRoom.participants.length,
          lastParticipantCount: lastParticipantCountRef.current,
        });

        if (updatedRoom.status === 'closed') {
          callbacks.onRoomClosed();
          return;
        }

        if (updatedRoom.status === 'waiting') {
          callbacks.onRoomWaiting(updatedRoom);
          return;
        }

        if (updatedRoom.status === 'open') {
          const effectiveCount = await calculateEffectiveParticipantCount(updatedRoom, roomId);
          callbacks.onRoomOpen(updatedRoom, effectiveCount);
        }
      });
    },
    [roomService, calculateEffectiveParticipantCount]
  );

  const unsubscribe = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    lastParticipantCountRef.current = 0;
  }, []);

  const getLastParticipantCount = useCallback((): number => {
    return lastParticipantCountRef.current;
  }, []);

  // useMemo ensures the returned object is the same reference between renders,
  // preventing ChatPage's useEffect from re-running unnecessarily.
  return useMemo(() => ({
    subscribe,
    unsubscribe,
    getLastParticipantCount,
  }), [subscribe, unsubscribe, getLastParticipantCount]);
}
