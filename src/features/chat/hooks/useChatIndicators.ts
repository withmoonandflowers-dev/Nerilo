/**
 * ChatPage 頂欄指示器邏輯（自 ChatPage 抽出，god-file 棘輪配套）：
 * - useE2eeMode：E2EE 狀態指示（ADR-0004 決策 4）。真值來源是 ChatService 的
 *   實際金鑰狀態，不是連線狀態；mesh 房間尚未支援 E2EE，誠實標示為傳輸層加密。
 * - useProtocolMismatch：Spec 009 §4.7 gossip 協議版本不合（房內有 v1 舊版節點）
 *   → fail-visible 提示「請雙方更新」，不靜默降級。
 */
import { useEffect, useState } from 'react';
import type { MeshChatService } from '../MeshChatService';
import type { ConnectionState } from '../../../types';

export type E2eeMode = 'p2p' | 'fallback' | 'exchanging' | 'mesh-dtls' | null;

export function useE2eeMode(deps: {
  isMesh: boolean;
  starChatService: { isE2EEEnabled: boolean; isE2EEReady: boolean } | null;
  connectionState: ConnectionState;
  connectionMode: string | null;
}): E2eeMode {
  const { isMesh, starChatService, connectionState, connectionMode } = deps;
  const e2eeMode: E2eeMode = (() => {
    if (isMesh) return 'mesh-dtls';
    const keysReady = !!starChatService && starChatService.isE2EEEnabled && starChatService.isE2EEReady;
    if (connectionState === 'connected') {
      return keysReady ? 'p2p' : 'exchanging';
    }
    if (connectionMode === 'firestore') {
      return keysReady ? 'fallback' : 'exchanging';
    }
    return null;
  })();

  // 金鑰交換完成的瞬間沒有 React 事件可觸發 re-render，以低頻輪詢補上
  const [, forceRefresh] = useState(0);
  useEffect(() => {
    if (e2eeMode !== 'exchanging') return;
    const timer = setInterval(() => forceRefresh((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [e2eeMode]);

  return e2eeMode;
}

/**
 * mesh 服務就緒後掛協議版本不合監聽（服務建立時點不定，輪詢到掛上為止）。
 * reconnectNonce 變更代表服務重建，需重掛。
 */
export function useProtocolMismatch(
  getMeshChatService: () => MeshChatService | null,
  reconnectNonce: number
): boolean {
  const [mismatch, setMismatch] = useState(false);
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const timer = setInterval(() => {
      const svc = getMeshChatService();
      if (!svc || unsub) return;
      unsub = svc.onProtocolMismatch(() => setMismatch(true));
      clearInterval(timer);
    }, 1000);
    return () => {
      clearInterval(timer);
      unsub?.();
    };
    // getMeshChatService 為穩定閉包（讀 ref），不列依賴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectNonce]);
  return mismatch;
}
