/**
 * Mesh 拓撲 P2P 連線管理 Hook
 */

import { useRef, useCallback, useMemo } from 'react';
import { logger } from '@/utils/logger';
import { MeshChatService } from '../MeshChatService';
import type { IChatStorage } from '../../../ports';
import type { ChatMessage, ConnectionState } from '../../../types';

export interface MeshTopologyState {
  meshChatService: MeshChatService | null;
  connectionState: ConnectionState;
  isInitialized: boolean;
}

export interface UseMeshTopologyOptions {
  chatStorage?: IChatStorage;
}

/**
 * Hook 用於管理 Mesh 拓撲 P2P 連線；可注入 chatStorage 以利測試與可插拔。
 */
export function useMeshTopology(options?: UseMeshTopologyOptions) {
  const chatStorage = options?.chatStorage;
  const meshChatServiceRef = useRef<MeshChatService | null>(null);
  const connectionStateRef = useRef<ConnectionState>('idle');
  const stateCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 使用 ref 儲存 callback，避免 StrictMode re-mount 後 closure stale
  const onMessageRef = useRef<((message: ChatMessage) => void) | null>(null);
  const onStateChangeRef = useRef<((state: ConnectionState) => void) | null>(null);

  /**
   * 初始化 Mesh 拓撲 P2P 連線
   */
  const initialize = useCallback(async (
    roomId: string,
    uid: string,
    onStateChange: (state: ConnectionState) => void,
    onMessage: (message: ChatMessage) => void
  ): Promise<void> => {
    // 更新 ref，確保後續的 callback 呼叫使用最新的函式
    onMessageRef.current = onMessage;
    onStateChangeRef.current = onStateChange;

    // 如果已有舊的連線，先清理再重建（支援 StrictMode re-mount）
    if (meshChatServiceRef.current) {
      logger.info('[useMeshTopology] Cleaning up previous instance before re-init');
      if (stateCheckIntervalRef.current) clearInterval(stateCheckIntervalRef.current);
      meshChatServiceRef.current.cleanup();
      meshChatServiceRef.current = null;
    }

    try {
      logger.info('[useMeshTopology] Initializing mesh topology', {
        roomId,
        uid,
      });

      const meshChatService = new MeshChatService(roomId, uid, chatStorage);
      await meshChatService.initialize();
      meshChatServiceRef.current = meshChatService;

      // 監聯連線狀態（透過 ref 呼叫，確保用最新的 callback）
      stateCheckIntervalRef.current = setInterval(() => {
        if (!meshChatServiceRef.current) {
          if (stateCheckIntervalRef.current) {
            clearInterval(stateCheckIntervalRef.current);
            stateCheckIntervalRef.current = null;
          }
          return;
        }
        const state = meshChatServiceRef.current.getConnectionState();
        if (state !== connectionStateRef.current) {
          logger.info('[useMeshTopology] Mesh connection state changed', {
            roomId,
            from: connectionStateRef.current,
            to: state,
          });
          connectionStateRef.current = state;
          onStateChangeRef.current?.(state);
        }
      }, 2000);

      // 載入歷史訊息
      meshChatService.loadHistory().then((messages) => {
        messages.forEach(m => onMessageRef.current?.(m));
      }).catch((err) => {
        logger.warn('[useMeshTopology] Failed to load history', err);
      });

      // 監聽新訊息（透過 ref，確保 StrictMode re-mount 後仍用最新的 addMessage）
      meshChatService.onMessage((msg) => onMessageRef.current?.(msg));
    } catch (error) {
      logger.error('[useMeshTopology] Error initializing', error);
      connectionStateRef.current = 'failed';
      onStateChangeRef.current?.('failed');
      throw error;
    }
  }, [chatStorage]);

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

  return useMemo(() => ({
    initialize,
    sendMessage,
    cleanup,
    getState,
  }), [initialize, sendMessage, cleanup, getState]);
}
