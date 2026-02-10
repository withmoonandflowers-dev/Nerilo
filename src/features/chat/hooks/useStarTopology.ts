/**
 * 星型拓撲 P2P 連線管理 Hook
 */

import { useRef, useCallback } from 'react';
import { P2PManager } from '../../../core/p2p/P2PManager';
import { ChatService } from '../ChatService';
import type { ChatMessage, ConnectionState } from '../../../types';

export interface StarTopologyState {
  p2pManager: P2PManager | null;
  chatService: ChatService | null;
  connectionState: ConnectionState;
  isInitialized: boolean;
}

/**
 * Hook 用於管理星型拓撲 P2P 連線
 */
export function useStarTopology() {
  const p2pManagerRef = useRef<P2PManager | null>(null);
  const chatServiceRef = useRef<ChatService | null>(null);
  const connectionStateRef = useRef<ConnectionState>('idle');

  /**
   * 初始化星型拓撲 P2P 連線
   */
  const initialize = useCallback(async (
    roomId: string,
    uid: string,
    isInitiator: boolean,
    onStateChange: (state: ConnectionState) => void,
    onMessage: (message: ChatMessage) => void
  ): Promise<void> => {
    if (p2pManagerRef.current) {
      console.log('[useStarTopology] Already initialized, skipping');
      return;
    }

    try {
      console.log('[useStarTopology] Initializing star topology', {
        roomId,
        uid,
        isInitiator,
      });

      // 建立 P2PManager
      const p2pManager = new P2PManager(roomId, uid, 'chat', isInitiator);
      await p2pManager.initialize();
      p2pManagerRef.current = p2pManager;

      // 監聽連線狀態
      const connectionManager = p2pManager.getConnectionManager();
      const stateUnsubscribe = connectionManager.onStateChange((state) => {
        console.log('[useStarTopology] Connection state changed', { roomId, state });
        connectionStateRef.current = state;
        onStateChange(state);
      });

      // 設置初始狀態為 connecting
      connectionStateRef.current = 'connecting';
      onStateChange('connecting');

      // 定期檢查連線狀態（作為備份機制，確保狀態正確更新）
      const stateCheckInterval = setInterval(() => {
        const pc = connectionManager.getPeerConnection();
        if (pc) {
          const pcState = pc.connectionState;
          let mappedState: ConnectionState;
          
          if (pcState === 'connected') {
            mappedState = 'connected';
          } else if (pcState === 'disconnected' || pcState === 'failed') {
            mappedState = 'failed';
          } else if (pcState === 'closed') {
            mappedState = 'closed';
          } else {
            mappedState = 'connecting';
          }
          
          // 如果狀態不同，更新狀態
          if (connectionStateRef.current !== mappedState) {
            console.log('[useStarTopology] State check detected change', {
              roomId,
              oldState: connectionStateRef.current,
              newState: mappedState,
              pcState,
            });
            connectionStateRef.current = mappedState;
            onStateChange(mappedState);
          }
        }
      }, 500); // 每 500ms 檢查一次（更頻繁）

      // 清理定時器（在 cleanup 時清理）
      (p2pManagerRef.current as any).__stateCheckInterval = stateCheckInterval;
      (p2pManagerRef.current as any).__stateUnsubscribe = stateUnsubscribe;

      // 等待 ChannelBus 準備好
      const checkChannelBus = setInterval(() => {
        const channelBus = p2pManager.getChannelBus();
        if (channelBus && channelBus.getReadyState() === 'open') {
          clearInterval(checkChannelBus);

          // 檢查連線狀態，如果已連線則更新
          const pc = connectionManager.getPeerConnection();
          if (pc && pc.connectionState === 'connected') {
            console.log('[useStarTopology] ChannelBus ready and connection is connected', { roomId });
            connectionStateRef.current = 'connected';
            onStateChange('connected');
          }

          // 初始化 ChatService
          const deviceId = p2pManager.getDeviceId();
          const chatService = new ChatService(
            channelBus,
            uid,
            deviceId,
            roomId
          );
          chatServiceRef.current = chatService;

          // 載入歷史訊息
          chatService.loadHistory().then((messages) => {
            messages.forEach(onMessage);
          });

          // 監聽新訊息
          chatService.onMessage(onMessage);
        }
      }, 100);

      // 清理定時器（30 秒超時，給更多時間建立連線）
      setTimeout(() => clearInterval(checkChannelBus), 30000);
    } catch (error) {
      console.error('[useStarTopology] Error initializing', error);
      connectionStateRef.current = 'failed';
      onStateChange('failed');
      throw error;
    }
  }, []);

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
   * 清理資源
   */
  const cleanup = useCallback(() => {
    if (p2pManagerRef.current) {
      // 清理狀態檢查定時器
      const stateCheckInterval = (p2pManagerRef.current as any).__stateCheckInterval;
      if (stateCheckInterval) {
        clearInterval(stateCheckInterval);
      }
      
      // 取消狀態監聽
      const stateUnsubscribe = (p2pManagerRef.current as any).__stateUnsubscribe;
      if (stateUnsubscribe) {
        stateUnsubscribe();
      }
      
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

  return {
    initialize,
    sendMessage,
    cleanup,
    getState,
  };
}
