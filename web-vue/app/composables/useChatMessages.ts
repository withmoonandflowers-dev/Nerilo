/**
 * 聊天訊息管理 — 對應 React 版 useChatMessages
 * 去重（messageId Set）＋ 因果排序（CausalOrderingBuffer）＋ HLC 排序，行為契約不變。
 */
import { ref, onUnmounted } from 'vue'
import type { ChatMessage, CausalMessage, DeliveryStatus } from '@legacy/types'
import { HybridLogicalClock } from '@legacy/core/clock/HybridLogicalClock'
import { CausalOrderingBuffer } from '@legacy/core/ordering/CausalOrderingBuffer'

function sortByHLC(messages: ChatMessage[]): ChatMessage[] {
  return messages.sort((a, b) => {
    if (a.hlc && b.hlc) return HybridLogicalClock.compare(a.hlc, b.hlc)
    return a.timestamp - b.timestamp
  })
}

export function useChatMessages() {
  const messages = ref<ChatMessage[]>([])
  const messageIds = new Set<string>()
  const causalBuffer = new CausalOrderingBuffer()

  const insert = (msg: ChatMessage) => {
    if (messageIds.has(msg.messageId)) return
    messageIds.add(msg.messageId)
    messages.value = sortByHLC([...messages.value, msg])
  }

  causalBuffer.onDeliver((msg, forced) => {
    if (forced) console.warn('[useChatMessages] force-delivered out-of-order message', msg.messageId)
    insert(msg)
  })

  onUnmounted(() => causalBuffer.destroy())

  const addMessage = (message: ChatMessage) => {
    if (messageIds.has(message.messageId)) return
    const causal = message as CausalMessage
    if (causal.deps !== undefined) {
      // 帶因果資訊（含空 deps）一律經緩衝器，與 React 版 GC2 修復一致
      causalBuffer.receive(causal)
    } else {
      insert(message)
    }
  }

  const setMessagesList = (newMessages: ChatMessage[]) => {
    messageIds.clear()
    newMessages.forEach((m) => messageIds.add(m.messageId))
    messages.value = [...newMessages]
  }

  const updateMessageStatus = (messageId: string, status: DeliveryStatus) => {
    messages.value = messages.value.map((m) =>
      m.messageId === messageId ? { ...m, deliveryStatus: status } : m
    )
  }

  return { messages, addMessage, setMessagesList, updateMessageStatus }
}
