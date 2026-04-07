/**
 * P2P 架構選擇 Hook
 * 根據參與者數量和房間配置自動選擇最適合的 P2P 架構
 */

import { useRef, useCallback, useMemo } from 'react';
import type { P2PRoom } from '../../../types';

export type ArchitectureType = 'star' | 'mesh';

export interface ArchitectureDecision {
  type: ArchitectureType;
  participantCount: number;
  reason: string;
}

/**
 * 決定應該使用哪種 P2P 架構
 * @param room 房間資訊
 * @param overrideParticipantCount 覆蓋參與者數量（用於處理 Firestore 同步延遲）
 * @returns 架構決策
 */
export function decideArchitecture(
  room: P2PRoom,
  overrideParticipantCount?: number
): ArchitectureDecision {
  const effectiveParticipantCount = overrideParticipantCount ?? room.participants.length;

  // 如果房間明確標記為 mesh，強制使用 Mesh 架構
  if (room.topology === 'mesh') {
    return {
      type: 'mesh',
      participantCount: effectiveParticipantCount,
      reason: 'Room topology explicitly set to mesh',
    };
  }

  // 3+ 人自動使用 Mesh topology（全鏈式 P2P：A↔B↔C↔D，Gossip 多跳轉發）
  // 2 人使用 Star topology（直連 DataChannel，延遲最低）
  if (effectiveParticipantCount >= 3) {
    return {
      type: 'mesh',
      participantCount: effectiveParticipantCount,
      reason: `Mesh topology for ${effectiveParticipantCount} participants (gossip relay, TTL=8)`,
    };
  }

  if (effectiveParticipantCount >= 2) {
    return {
      type: 'star',
      participantCount: effectiveParticipantCount,
      reason: `Star topology for ${effectiveParticipantCount} participants (direct P2P)`,
    };
  }

  // 單人或無參與者，預設使用星型拓撲（但實際上不會初始化）
  return {
    type: 'star',
    participantCount: effectiveParticipantCount,
    reason: `Participant count is ${effectiveParticipantCount} (default to star)`,
  };
}

/**
 * Hook 用於管理 P2P 架構決策
 */
export function useP2PArchitecture() {
  const currentArchitectureRef = useRef<ArchitectureDecision | null>(null);

  const decide = useCallback((room: P2PRoom, overrideParticipantCount?: number): ArchitectureDecision => {
    const decision = decideArchitecture(room, overrideParticipantCount);
    currentArchitectureRef.current = decision;
    return decision;
  }, []);

  const getCurrent = useCallback((): ArchitectureDecision | null => {
    return currentArchitectureRef.current;
  }, []);

  const isMesh = useCallback((): boolean => {
    return currentArchitectureRef.current?.type === 'mesh';
  }, []);

  const isStar = useCallback((): boolean => {
    return currentArchitectureRef.current?.type === 'star';
  }, []);

  // useMemo ensures the returned object is the same reference between renders,
  // preventing ChatPage's useEffect from re-running unnecessarily.
  return useMemo(() => ({
    decide,
    getCurrent,
    isMesh,
    isStar,
  }), [decide, getCurrent, isMesh, isStar]);
}
