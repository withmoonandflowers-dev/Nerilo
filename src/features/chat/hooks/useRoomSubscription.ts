/**
 * 房間訂閱管理 Hook
 * 處理房間狀態變化、參與者數量追蹤、Firestore 同步延遲等問題
 */

import { useRef, useCallback } from 'react';
import { RoomService } from '../../../services/RoomService';
import type { P2PRoom } from '../../../types';

export interface RoomSubscriptionCallbacks {
  onRoomClosed: () => void;
  onRoomWaiting: (room: P2PRoom) => void;
  onRoomOpen: (room: P2PRoom, effectiveParticipantCount: number) => void;
  onRoomNotFound: () => void;
}

/**
 * Hook 用於管理房間訂閱和參與者數量追蹤
 */
export function useRoomSubscription() {
  const lastParticipantCountRef = useRef<number>(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * 計算有效的參與者數量（處理 Firestore 同步延遲）
   */
  const calculateEffectiveParticipantCount = useCallback(
    async (
      room: P2PRoom,
      roomId: string
    ): Promise<number> => {
      const currentCount = room.participants.length;
      const lastCount = lastParticipantCountRef.current;

      // 如果房間狀態是 open，但參與者數量從多變少，可能是快取問題
      if (room.status === 'open' && lastCount >= 2 && currentCount < lastCount && lastCount > 0) {
        console.warn('[useRoomSubscription] Participant count decreased, forcing server read', {
          roomId,
          cachedCount: currentCount,
          lastCount,
        });

        // 強制從伺服器讀取最新資料
        const serverRoom = await RoomService.getRoom(roomId, true);
        if (serverRoom && serverRoom.participants.length !== currentCount) {
          const serverCount = serverRoom.participants.length;
          const effective = room.status === 'open' && serverCount < 2 ? 2 : serverCount;
          console.log('[useRoomSubscription] Server room data differs, using server data', {
            roomId,
            cachedCount: currentCount,
            serverCount,
            effective,
          });
          lastParticipantCountRef.current = effective;
          return effective;
        }
      }

      // 房間為 open 表示至少已有 2 人；若讀到 0 或 1 視為 Firestore 同步延遲
      if (room.status === 'open' && currentCount < 2) {
        console.log('[useRoomSubscription] Room has', currentCount, 'participant(s) but status is open (likely sync delay)', {
          roomId,
        });
        lastParticipantCountRef.current = 2;
        return 2;
      }

      // 參與者數量增加，更新追蹤值
      if (currentCount > lastCount) {
        lastParticipantCountRef.current = currentCount;
      } else if (lastCount === 0) {
        // 首次讀取，更新追蹤值
        lastParticipantCountRef.current = currentCount;
      }

      return currentCount;
    },
    []
  );

  /**
   * 訂閱房間變化
   */
  const subscribe = useCallback(
    async (
      roomId: string,
      callbacks: RoomSubscriptionCallbacks
    ): Promise<void> => {
      // 先從伺服器讀取一次，初始化 lastParticipantCount
      const initialRoom = await RoomService.getRoom(roomId, true);
      if (!initialRoom) {
        callbacks.onRoomNotFound();
        return;
      }

      lastParticipantCountRef.current = initialRoom.participants.length;

      // 如果初始房間狀態是 open，且參與者數量是 1，假設實際是 2
      if (initialRoom.status === 'open' && initialRoom.participants.length === 1) {
        lastParticipantCountRef.current = 2;
      }

      // 訂閱房間變化
      unsubscribeRef.current = RoomService.subscribeRoom(roomId, async (updatedRoom) => {
        if (!updatedRoom) {
          callbacks.onRoomNotFound();
          return;
        }

        console.log('[useRoomSubscription] Room updated via subscription', {
          roomId,
          status: updatedRoom.status,
          participants: updatedRoom.participants.length,
          lastParticipantCount: lastParticipantCountRef.current,
        });

        // 如果房間是 closed 狀態
        if (updatedRoom.status === 'closed') {
          callbacks.onRoomClosed();
          return;
        }

        // 如果房間仍然是 waiting 狀態
        if (updatedRoom.status === 'waiting') {
          callbacks.onRoomWaiting(updatedRoom);
          return;
        }

        // 如果房間狀態是 open，計算有效的參與者數量
        if (updatedRoom.status === 'open') {
          const effectiveCount = await calculateEffectiveParticipantCount(updatedRoom, roomId);
          callbacks.onRoomOpen(updatedRoom, effectiveCount);
        }
      });
    },
    [calculateEffectiveParticipantCount]
  );

  /**
   * 取消訂閱
   */
  const unsubscribe = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    lastParticipantCountRef.current = 0;
  }, []);

  /**
   * 獲取最後已知的參與者數量
   */
  const getLastParticipantCount = useCallback((): number => {
    return lastParticipantCountRef.current;
  }, []);

  return {
    subscribe,
    unsubscribe,
    getLastParticipantCount,
  };
}
