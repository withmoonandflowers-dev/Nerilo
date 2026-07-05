/**
 * 星型拓撲 P2P 控制器 — 對應 React 版 useStarTopology（src/features/chat/hooks/useStarTopology.ts）
 * 原 hook 只用 ref 存實例、無渲染邏輯，這裡改寫為框架無關的 class，行為契約逐段對齊。
 */
import { P2PManager } from '@legacy/core/p2p/P2PManager'
import { ChatService } from '@legacy/features/chat/ChatService'
import { SenderKeyManager } from '@legacy/core/crypto/SenderKeyManager'
import type { IChatStorage } from '@legacy/ports'
import type { ChatMessage, ConnectionState } from '@legacy/types'

export class StarTopologyController {
  private p2pManager: P2PManager | null = null
  private chatService: ChatService | null = null
  private senderKeyManager: SenderKeyManager | null = null
  private connectionState: ConnectionState = 'idle'
  private stateCheckInterval: ReturnType<typeof setInterval> | null = null
  private stateUnsubscribe: (() => void) | null = null
  private onMessageCb: ((message: ChatMessage) => void) | null = null
  private onStateChangeCb: ((state: ConnectionState) => void) | null = null

  constructor(private chatStorage?: IChatStorage) {}

  /** 遊戲等其他 namespace consumer 直接騎 bus（game-integration-spec §2）；未連線時 null */
  getChannelBus() {
    return this.p2pManager?.getChannelBus() ?? null
  }

  async initialize(
    roomId: string,
    uid: string,
    isInitiator: boolean,
    onStateChange: (state: ConnectionState) => void,
    onMessage: (message: ChatMessage) => void
  ): Promise<void> {
    this.onMessageCb = onMessage
    this.onStateChangeCb = onStateChange

    if (this.p2pManager) this.cleanup()

    try {
      const p2pManager = new P2PManager(roomId, uid, 'chat', isInitiator)
      await p2pManager.initialize()
      this.p2pManager = p2pManager

      // ADR-0004：星型路徑 E2EE 預設開啟
      const senderKeyManager = new SenderKeyManager(uid)
      await senderKeyManager.initKeyPair()
      this.senderKeyManager = senderKeyManager

      const connectionManager = p2pManager.getConnectionManager()
      this.stateUnsubscribe = connectionManager.onStateChange((state) => {
        this.connectionState = state
        this.onStateChangeCb?.(state)
      })

      this.connectionState = 'connecting'
      this.onStateChangeCb?.('connecting')

      // 定期檢查連線狀態：只處理最終態，忽略暫態避免 connected↔connecting 震盪
      this.stateCheckInterval = setInterval(() => {
        const pc = connectionManager.getPeerConnection()
        if (!pc) return
        const pcState = pc.connectionState
        let mapped: ConnectionState | null = null
        if (pcState === 'connected' && this.connectionState !== 'connected') mapped = 'connected'
        else if (pcState === 'failed' && this.connectionState !== 'failed') mapped = 'failed'
        else if (pcState === 'closed' && this.connectionState !== 'closed') mapped = 'closed'
        if (mapped) {
          this.connectionState = mapped
          this.onStateChangeCb?.(mapped)
        }
      }, 2000)

      // 等待 ChannelBus 開啟後掛上 ChatService（30 秒超時）
      const checkChannelBus = setInterval(() => {
        const channelBus = p2pManager.getChannelBus()
        if (channelBus && channelBus.getReadyState() === 'open') {
          clearInterval(checkChannelBus)

          const pc = connectionManager.getPeerConnection()
          if (pc && pc.connectionState === 'connected') {
            this.connectionState = 'connected'
            this.onStateChangeCb?.('connected')
          }

          const chatService = new ChatService(
            channelBus,
            uid,
            p2pManager.getDeviceId(),
            roomId,
            this.chatStorage,
            senderKeyManager
          )
          this.chatService = chatService

          // 廣播 ECDH 公鑰，啟動金鑰交換（雙方各自廣播，先到先答）
          chatService.initiateKeyExchange().catch((err) => {
            console.error('[StarTopology] E2EE key exchange initiation failed', err)
          })

          chatService.loadHistory().then((messages: ChatMessage[]) => {
            messages.forEach((m) => this.onMessageCb?.(m))
          })

          chatService.onMessage((msg: ChatMessage) => this.onMessageCb?.(msg))
        }
      }, 100)
      setTimeout(() => clearInterval(checkChannelBus), 30000)
    } catch (error) {
      this.connectionState = 'failed'
      this.onStateChangeCb?.('failed')
      throw error
    }
  }

  async sendMessage(content: string, messageId?: string): Promise<void> {
    if (!this.chatService) throw new Error('ChatService not initialized')
    await this.chatService.sendMessage(content, undefined, messageId)
  }

  async sendTyping(isTyping: boolean): Promise<void> {
    try {
      await this.chatService?.sendTyping(isTyping)
    } catch {
      /* typing 是 best-effort */
    }
  }

  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void {
    if (this.chatService) return this.chatService.onTyping(listener)
    let unsubscribe: (() => void) | null = null
    const interval = setInterval(() => {
      if (this.chatService && !unsubscribe) {
        unsubscribe = this.chatService.onTyping(listener)
        clearInterval(interval)
      }
    }, 200)
    return () => {
      clearInterval(interval)
      unsubscribe?.()
    }
  }

  getChatService(): ChatService | null {
    return this.chatService
  }

  cleanup(): void {
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval)
      this.stateCheckInterval = null
    }
    if (this.stateUnsubscribe) {
      this.stateUnsubscribe()
      this.stateUnsubscribe = null
    }
    this.p2pManager?.close()
    this.p2pManager = null
    this.chatService = null
    this.senderKeyManager?.destroy()
    this.senderKeyManager = null
    this.connectionState = 'idle'
  }
}
