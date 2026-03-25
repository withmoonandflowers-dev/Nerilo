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

  // ── Mesh 架構目前僅用於「房間明確設為 mesh」的情況 ──
  // 自動 Star→Mesh 遷移尚未實作（既有 Star 使用者不會註冊 meshIdentities，
  // 導致第 3 人加入時 discoverNodes() 找不到節點）。
  // 在遷移機制完成前，3+ 人房間仍使用 Star 拓撲（hub-and-spoke）。
  // TODO: 實作 Star→Mesh 遷移協議後，將閾值降回 3。
  if (effectiveParticipantCount >= 2) {
    return {
      type: 'star',
      participantCount: effectiveParticipantCount,
      reason: `Star topology for ${effectiveParticipantCount} participants (Mesh migration not yet implemented)`,
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
