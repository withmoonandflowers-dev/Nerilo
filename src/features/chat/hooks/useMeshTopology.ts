/**
 * Mesh 拓撲 P2P 連線管理 Hook
 */

import { useRef, useCallback } from 'react';
import { MeshChatService } from '../MeshChatService';
import type { ChatMessage, ConnectionState } from '../../../types';

export interface MeshTopologyState {
  meshChatService: MeshChatService | null;
  connectionState: ConnectionState;
  isInitialized: boolean;
}

/**
 * Hook 用於管理 Mesh 拓撲 P2P 連線
 */
export function useMeshTopology() {
  const meshChatServiceRef = useRef<MeshChatService | null>(null);
  const connectionStateRef = useRef<ConnectionState>('idle');
  const stateCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * 初始化 Mesh 拓撲 P2P 連線
   */
  const initialize = useCallback(async (
    roomId: string,
    uid: string,
    onStateChange: (state: ConnectionState) => void,
    onMessage: (message: ChatMessage) => void
  ): Promise<void> => {
    if (meshChatServiceRef.current) {
      console.log('[useMeshTopology] Already initialized, skipping');
      return;
    }

    try {
      console.log('[useMeshTopology] Initializing mesh topology', {
        roomId,
        uid,
      });

      // 建立 MeshChatService
      const meshChatService = new MeshChatService(roomId, uid);
      await meshChatService.initialize();
      meshChatServiceRef.current = meshChatService;

      // 監聽連線狀態（持續監聽，因為 Mesh 連線可能需要時間）
      stateCheckIntervalRef.current = setInterval(() => {
        if (!meshChatServiceRef.current) {
          if (stateCheckIntervalRef.current) {
            clearInterval(stateCheckIntervalRef.current);
            stateCheckIntervalRef.current = null;
          }
          return;
        }
        const state = meshChatServiceRef.current.getConnectionState();
        connectionStateRef.current = state;
        onStateChange(state);

        // 只在狀態變化時記錄
        if (state === 'connected') {
          console.log('[useMeshTopology] Mesh connection established', {
            roomId,
            state,
          });
        }
      }, 2000); // 每 2 秒檢查一次

      // 載入歷史訊息
      meshChatService.loadHistory().then((messages) => {
        messages.forEach(onMessage);
      });

      // 監聽新訊息
      meshChatService.onMessage(onMessage);
    } catch (error) {
      console.error('[useMeshTopology] Error initializing', error);
      connectionStateRef.current = 'failed';
      onStateChange('failed');
      throw error;
    }
  }, []);

  /**
   * 發送訊息
   */
  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (!meshChatServiceRef.current) {
      throw new Error('MeshChatService not initialized');
    }
    await meshChatServiceRef.current.sendMessage(content);
  }, []);

  /**
   * 清理資源
   */
  const cleanup = useCallback(() => {
    if (stateCheckIntervalRef.current) {
      clearInterval(stateCheckIntervalRef.current);
      stateCheckIntervalRef.current = null;
    }
    if (meshChatServiceRef.current) {
      meshChatServiceRef.current.cleanup();
      meshChatServiceRef.current = null;
    }
    connectionStateRef.current = 'idle';
  }, []);

  /**
   * 獲取當前狀態
   */
  const getState = useCallback((): MeshTopologyState => {
    return {
      meshChatService: meshChatServiceRef.current,
      connectionState: connectionStateRef.current,
      isInitialized: meshChatServiceRef.current !== null,
    };
  }, []);

  return {
    initialize,
    sendMessage,
    cleanup,
    getState,
  };
}
