/**
 * 星型拓撲 P2P 連線管理 Hook
 */

import { useRef, useCallback, useMemo } from 'react';
import { P2PManager } from '../../../core/p2p/P2PManager';
import { ChatService } from '../ChatService';
import type { IChatStorage } from '../../../ports';
import type { ChatMessage, ConnectionState } from '../../../types';
import { logger } from '../../../utils/logger';

export interface StarTopologyState {
  p2pManager: P2PManager | null;
  chatService: ChatService | null;
  connectionState: ConnectionState;
  isInitialized: boolean;
}

export interface UseStarTopologyOptions {
  chatStorage?: IChatStorage;
}

/**
 * Hook 用於管理星型拓撲 P2P 連線；可注入 chatStorage 以利測試與可插拔。
 */
export function useStarTopology(options?: UseStarTopologyOptions) {
  const chatStorage = options?.chatStorage;
  const p2pManagerRef = useRef<P2PManager | null>(null);
  const chatServiceRef = useRef<ChatService | null>(null);
  const connectionStateRef = useRef<ConnectionState>('idle');
  const stateCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateUnsubscribeRef = useRef<(() => void) | null>(null);

  /**
   * 初始化星型拓撲 P2P 連線
   */
  // 使用 ref 儲存 callback，確保 ChatService listener 總是呼叫最新的版本
  // （避免 React StrictMode re-mount 後 closure stale 問題）
  const onMessageRef = useRef<((message: ChatMessage) => void) | null>(null);
  const onStateChangeRef = useRef<((state: ConnectionState) => void) | null>(null);

  const initialize = useCallback(async (
    roomId: string,
    uid: string,
    isInitiator: boolean,
    onStateChange: (state: ConnectionState) => void,
    onMessage: (message: ChatMessage) => void
  ): Promise<void> => {
    // 更新 ref，確保後續的 callback 呼叫使用最新的函式
    onMessageRef.current = onMessage;
    onStateChangeRef.current = onStateChange;

    // 如果已有舊的連線，先清理再重建（支援 StrictMode re-mount）
    if (p2pManagerRef.current) {
      logger.info('[useStarTopology] Cleaning up previous instance before re-init');
      if (stateCheckIntervalRef.current) clearInterval(stateCheckIntervalRef.current);
      if (stateUnsubscribeRef.current) stateUnsubscribeRef.current();
      p2pManagerRef.current.close();
      p2pManagerRef.current = null;
      chatServiceRef.current = null;
    }

    try {
      logger.info('[useStarTopology] Initializing star topology', {
        roomId,
        uid,
        isInitiator,
      });

      // 建立 P2PManager
      const p2pManager = new P2PManager(roomId, uid, 'chat', isInitiator);
      await p2pManager.initialize();
      p2pManagerRef.current = p2pManager;

      // 監聽連線狀態（透過 ref 呼叫，確保用最新的 callback）
      const connectionManager = p2pManager.getConnectionManager();
      const stateUnsubscribe = connectionManager.onStateChange((state) => {
        logger.info('[useStarTopology] Connection state changed', { roomId, state });
        connectionStateRef.current = state;
        onStateChangeRef.current?.(state);
      });

      // 設置初始狀態為 connecting
      connectionStateRef.current = 'connecting';
      onStateChangeRef.current?.('connecting');

      // 定期檢查連線狀態（備份機制，只關注重大變化）
      // 重要：只處理「最終態」(connected/failed/closed)，
      // 忽略暫態 (new/connecting/disconnected) 以避免 connected↔connecting 震盪。
      const stateCheckInterval = setInterval(() => {
        const pc = connectionManager.getPeerConnection();
        if (!pc) return;

        const pcState = pc.connectionState;
        let mappedState: ConnectionState | null = null;

        if (pcState === 'connected' && connectionStateRef.current !== 'connected') {
          mappedState = 'connected';
        } else if (pcState === 'failed' && connectionStateRef.current !== 'failed') {
          mappedState = 'failed';
        } else if (pcState === 'closed' && connectionStateRef.current !== 'closed') {
          mappedState = 'closed';
        }
        // 不處理 'new'/'connecting'/'disconnected' → 避免 connected↔connecting 震盪

        if (mappedState) {
          logger.info('[useStarTopology] State check detected change', {
            roomId,
            oldState: connectionStateRef.current,
            newState: mappedState,
            pcState,
          });
          connectionStateRef.current = mappedState;
          onStateChangeRef.current?.(mappedState);
        }
      }, 2000); // 每 2 秒檢查一次（降頻避免不必要的 re-render）

      stateCheckIntervalRef.current = stateCheckInterval;
      stateUnsubscribeRef.current = stateUnsubscribe;

      // 等待 ChannelBus 準備好
      const checkChannelBus = setInterval(() => {
        const channelBus = p2pManager.getChannelBus();
        if (channelBus && channelBus.getReadyState() === 'open') {
          clearInterval(checkChannelBus);

          // 檢查連線狀態，如果已連線則更新
          const pc = connectionManager.getPeerConnection();
          if (pc && pc.connectionState === 'connected') {
            logger.info('[useStarTopology] ChannelBus ready and connection is connected', { roomId });
            connectionStateRef.current = 'connected';
            onStateChangeRef.current?.('connected');
          }

          const deviceId = p2pManager.getDeviceId();
          const chatService = new ChatService(
            channelBus,
            uid,
            deviceId,
            roomId,
            chatStorage
          );
          chatServiceRef.current = chatService;

          // 載入歷史訊息
          chatService.loadHistory().then((messages) => {
            messages.forEach(m => onMessageRef.current?.(m));
          });

          // 監聽新訊息（透過 ref 呼叫，確保 StrictMode re-mount 後仍用最新的 addMessage）
          chatService.onMessage((msg) => {
            logger.info('[useStarTopology] onMessage wrapper called', {
              messageId: msg.messageId,
              hasRef: !!onMessageRef.current,
            });
            onMessageRef.current?.(msg);
          });
        }
      }, 100);

      // 清理定時器（30 秒超時，給更多時間建立連線）
      setTimeout(() => clearInterval(checkChannelBus), 30000);
    } catch (error) {
      logger.error('[useStarTopology] Error initializing', error);
      connectionStateRef.current = 'failed';
      onStateChangeRef.current?.('failed');
      throw error;
    }
  }, [chatStorage]);

  /**
   * 發送訊息
   */
  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (!chatServiceRef.current) {
      throw new Error('ChatService not initialized');
    }
    await chatServiceRef.current.sendMessage(content);
  }, []);

  /**
   * 發送 typing 狀態
   */
  const sendTyping = useCallback(async (isTyping: boolean): Promise<void> => {
    if (!chatServiceRef.current) return;
    try {
      await chatServiceRef.current.sendTyping(isTyping);
    } catch {
      // typing indicator is best-effort, ignore errors
    }
  }, []);

  /**
   * 監聽對方 typing 狀態
   */
  const onTyping = useCallback((listener: (data: { userId: string; isTyping: boolean }) => void): (() => void) => {
    // Store listener in a ref-based approach so it works even if chatService isn't ready yet
    const wrapper = (data: { userId: string; isTyping: boolean }) => listener(data);
    // If chatService is already available, register immediately
    if (chatServiceRef.current) {
      return chatServiceRef.current.onTyping(wrapper);
    }
    // Otherwise, we'll need to register later - use an interval to check
    let unsubscribe: (() => void) | null = null;
    const interval = setInterval(() => {
      if (chatServiceRef.current && !unsubscribe) {
        unsubscribe = chatServiceRef.current.onTyping(wrapper);
        clearInterval(interval);
      }
    }, 200);
    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }, []);

  /**
   * 清理資源
   */
  const cleanup = useCallback(() => {
    // 清理狀態檢查定時器
    if (stateCheckIntervalRef.current) {
      clearInterval(stateCheckIntervalRef.current);
      stateCheckIntervalRef.current = null;
    }

    // 取消狀態監聽
    if (stateUnsubscribeRef.current) {
      stateUnsubscribeRef.current();
      stateUnsubscribeRef.current = null;
    }

    if (p2pManagerRef.current) {
      p2pManagerRef.current.close();
      p2pManagerRef.current = null;
    }
    chatServiceRef.current = null;
    connectionStateRef.current = 'idle';
  }, []);

  /**
   * 獲取當前狀態
   */
  const getState = useCallback((): StarTopologyState => {
    return {
      p2pManager: p2pManagerRef.current,
      chatService: chatServiceRef.current,
      connectionState: connectionStateRef.current,
      isInitialized: p2pManagerRef.current !== null,
    };
  }, []);

  // useMemo ensures the returned object is the same reference between renders,
  // preventing ChatPage's useEffect from re-running unnecessarily.
  return useMemo(() => ({
    initialize,
    sendMessage,
    sendTyping,
    onTyping,
    cleanup,
    getState,
  }), [initialize, sendMessage, sendTyping, onTyping, cleanup, getState]);
}
