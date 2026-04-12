/**
 * 聊天訊息管理 Hook
 * 處理訊息的添加、去重、歷史載入、因果排序等
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { logger } from '@/utils/logger';
import type { ChatMessage, CausalMessage, DeliveryStatus } from '../../../types';
import { HybridLogicalClock } from '../../../core/clock/HybridLogicalClock';
import { CausalOrderingBuffer } from '../../../core/ordering/CausalOrderingBuffer';

/** Compare two messages by HLC then timestamp */
function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.hlc && b.hlc) return HybridLogicalClock.compare(a.hlc, b.hlc);
  return a.timestamp - b.timestamp;
}

/**
 * Insert a message into an already-sorted array using binary search — O(log N).
 * Falls back to full sort if the array is unsorted (e.g. bulk load).
 */
function insertSorted(sorted: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  // Fast path: new message belongs at the end (most common case)
  if (sorted.length === 0 || compareMessages(msg, sorted[sorted.length - 1]) >= 0) {
    return [...sorted, msg];
  }

  // Binary search for insertion point
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareMessages(sorted[mid], msg) < 0) lo = mid + 1;
    else hi = mid;
  }

  const result = [...sorted];
  result.splice(lo, 0, msg);
  return result;
}

/** Full sort — used only for bulk loading (addMessages / setMessagesList) */
function sortByHLC(messages: ChatMessage[]): ChatMessage[] {
  return messages.sort(compareMessages);
}

/**
 * Hook 用於管理聊天訊息
 *
 * 重要設計決策：所有 callback 使用 `setMessagesRef.current` 而非直接捕獲 `setMessages`，
 * 確保在 React StrictMode（開發模式）的 unmount→re-mount 週期中，
 * 外部持有的 callback reference 總是操作**當前活躍** component instance 的 state。
 */
export function useChatMessages() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messageIdsRef = useRef<Set<string>>(new Set());

  // 用 ref 持有 setMessages，確保 callback 閉包總是呼叫當前 instance 的 setter
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  // CausalOrderingBuffer — held in ref to persist across renders
  const causalBufferRef = useRef<CausalOrderingBuffer>(new CausalOrderingBuffer());

  // Wire up delivery callback
  useEffect(() => {
    const buffer = causalBufferRef.current;
    buffer.onDeliver((msg, forced) => {
      if (forced) {
        logger.warn('[useChatMessages] Force-delivered out-of-order message', {
          messageId: msg.messageId,
        });
      }
      // Actually insert into the state via the dedup + HLC sort path
      setMessagesRef.current((prev) => {
        if (messageIdsRef.current.has(msg.messageId)) return prev;
        messageIdsRef.current.add(msg.messageId);
        return insertSorted(prev, msg);
      });
    });

    return () => {
      buffer.destroy();
    };
  }, []);

  /**
   * 添加訊息（自動去重 + 因果排序 + HLC 排序）
   * 若訊息有 deps 欄位（CausalMessage），會先經過 CausalOrderingBuffer。
   * 若無 deps，直接加入（向下相容舊版訊息）。
   */
  const addMessage = useCallback((message: ChatMessage) => {
    // Avoid processing duplicates early
    if (messageIdsRef.current.has(message.messageId)) return;

    const causal = message as CausalMessage;
    if (causal.deps && causal.deps.length > 0) {
      // Route through causal ordering buffer
      causalBufferRef.current.receive(causal);
    } else {
      // No deps — deliver immediately (backwards compatible)
      setMessagesRef.current((prev) => {
        if (messageIdsRef.current.has(message.messageId)) return prev;
        messageIdsRef.current.add(message.messageId);
        return sortByHLC([...prev, message]);
      });
    }
  }, []);

  /**
   * 批量添加訊息（用於載入歷史）
   */
  const addMessages = useCallback((newMessages: ChatMessage[]) => {
    setMessagesRef.current((prev) => {
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
    setMessagesRef.current(newMessages);
  }, []);

  /**
   * 更新指定訊息的傳送狀態
   */
  const updateMessageStatus = useCallback((messageId: string, status: DeliveryStatus) => {
    setMessagesRef.current((prev) =>
      prev.map((m) =>
        m.messageId === messageId ? { ...m, deliveryStatus: status } : m
      )
    );
  }, []);

  /**
   * 清空訊息
   */
  const clearMessages = useCallback(() => {
    messageIdsRef.current.clear();
    setMessagesRef.current([]);
  }, []);

  return {
    messages,
    addMessage,
    addMessages,
    setMessagesList,
    clearMessages,
    updateMessageStatus,
  };
}
