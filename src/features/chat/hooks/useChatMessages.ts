/**
 * 聊天訊息管理 Hook
 * 處理訊息的添加、去重、歷史載入等
 */

import { useState, useCallback, useRef } from 'react';
import type { ChatMessage } from '../../../types';

/**
 * Hook 用於管理聊天訊息
 */
export function useChatMessages() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messageIdsRef = useRef<Set<string>>(new Set());

  /**
   * 添加訊息（自動去重）
   */
  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => {
      // 避免重複訊息
      if (messageIdsRef.current.has(message.messageId)) {
        return prev;
      }
      messageIdsRef.current.add(message.messageId);
      return [...prev, message];
    });
  }, []);

  /**
   * 批量添加訊息（用於載入歷史）
   */
  const addMessages = useCallback((newMessages: ChatMessage[]) => {
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.messageId));
      const uniqueMessages = newMessages.filter(
        (m) => !existingIds.has(m.messageId) && !messageIdsRef.current.has(m.messageId)
      );
      uniqueMessages.forEach((m) => messageIdsRef.current.add(m.messageId));
      return [...prev, ...uniqueMessages];
    });
  }, []);

  /**
   * 設置訊息列表（用於載入歷史）
   */
  const setMessagesList = useCallback((newMessages: ChatMessage[]) => {
    messageIdsRef.current.clear();
    newMessages.forEach((m) => messageIdsRef.current.add(m.messageId));
    setMessages(newMessages);
  }, []);

  /**
   * 清空訊息
   */
  const clearMessages = useCallback(() => {
    messageIdsRef.current.clear();
    setMessages([]);
  }, []);

  return {
    messages,
    addMessage,
    addMessages,
    setMessagesList,
    clearMessages,
  };
}
