import { MeshGossipManager } from '../../core/mesh/MeshGossipManager';
import type { IChatStorage } from '../../ports';
import { indexedDBService } from '../../services/IndexedDBService';
import type { ChatMessage, GossipMessage, P2PEnvelope } from '../../types';
import type { FallbackEncryptedContent } from '../../services/FirestoreChatFallback';
import type { ReactionEvent, ReactionOp } from './reactions';
import type { ReadEvent } from './readReceipts';
import type { EncryptionState } from './encryptionGate';
import type { SignalingFactory } from '../../core/p2p/SignalingTransport';
import type { IRoomDirectory } from '../../ports/IRoomDirectory';
import { logger } from '../../utils/logger';

/**
 * Mesh Chat Service
 * 使用 Gossip 協議處理聊天訊息；支援注入 IChatStorage 以利測試與可插拔。
 */
export class MeshChatService {
  private meshGossipManager: MeshGossipManager;
  private chatStorage: IChatStorage;
  private messageListeners: Set<(message: ChatMessage) => void> = new Set();
  /** 遊戲事件監聽器（M4 channel:'game'）。content 是 P2PEnvelope JSON，不進聊天顯示。 */
  private gameListeners: Set<(env: P2PEnvelope) => void> = new Set();
  /** 表情 reaction 監聽器（channel:'reaction'）。content 是 {messageId,emoji,op} JSON。 */
  private reactionListeners: Set<(r: ReactionEvent) => void> = new Set();
  /** 已讀水位監聽器（channel:'read'）。content 是 {watermark} JSON。 */
  private readListeners: Set<(r: ReadEvent) => void> = new Set();
  private messageCounter = 0;
  /** 本機的 mesh userId（hash pubKey）。gossip senderId 用此，非 firebase uid。 */
  private meshUserId: string | null = null;

  constructor(
    private roomId: string,
    private localUid: string,
    chatStorage: IChatStorage = indexedDBService,
    signalingFactory?: SignalingFactory, // 省略＝Firestore；SDK 注入自架後端（P2a）
    directory?: IRoomDirectory, // 省略＝Firestore 名冊/發現；SDK 注入自架後端（P2b）
    introducerUid?: string // 邀請連結指名的介紹人（Spec 005 T4）：先連他、其餘 pair 走 warm 中繼
  ) {
    this.meshGossipManager = new MeshGossipManager(roomId, localUid, signalingFactory, directory, introducerUid);
    this.chatStorage = chatStorage;
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    await this.meshGossipManager.initialize();
    // gossip 的 senderId 是 mesh userId（hash pubKey），不是 firebase uid。
    // 取本機 mesh userId 以正確過濾「自己的訊息」（否則自訊息會重複顯示）。
    this.meshUserId = this.meshGossipManager.getUserId();

    // 監聽 Gossip 訊息
    this.meshGossipManager.onMessage((gossipMessage: GossipMessage) => {
      // 遊戲事件（M4 channel:'game'）：content 是 P2PEnvelope JSON → 分流給遊戲監聽器，
      // 不進聊天顯示。走同一條可靠 gossip 管線（回合制/lockstep 適用，見 transport-contract-M4）。
      if (gossipMessage.channel === 'game') {
        let env: P2PEnvelope;
        try {
          env = JSON.parse(gossipMessage.content) as P2PEnvelope;
        } catch {
          logger.warn('[MeshChatService] malformed game envelope ignored', {
            roomId: this.roomId, senderId: gossipMessage.senderId, seq: gossipMessage.seq,
          });
          return;
        }
        this.gameListeners.forEach((l) => {
          try {
            l(env);
          } catch (error) {
            logger.error('[MeshChatService] Error in game listener', { error });
          }
        });
        return;
      }
      // 表情 reaction（channel:'reaction'）：content 是 {messageId,emoji,op} JSON → 分流給
      // reaction 監聽器（不進聊天顯示）。走同一條可靠 + E2EE gossip 管線，聚合冪等（見 reactions.ts）。
      if (gossipMessage.channel === 'reaction') {
        if (gossipMessage.senderId === this.meshUserId) return; // 自己的回音（本機已樂觀套用）
        try {
          const { messageId, emoji, op } = JSON.parse(gossipMessage.content) as {
            messageId: string; emoji: string; op: ReactionOp;
          };
          if (typeof messageId !== 'string' || typeof emoji !== 'string') return;
          const ev: ReactionEvent = { messageId, emoji, from: gossipMessage.senderId, op: op === 'remove' ? 'remove' : 'add' };
          this.reactionListeners.forEach((l) => {
            try { l(ev); } catch (error) { logger.error('[MeshChatService] Error in reaction listener', { error }); }
          });
        } catch {
          logger.warn('[MeshChatService] malformed reaction ignored', { roomId: this.roomId, seq: gossipMessage.seq });
        }
        return;
      }
      // 已讀水位（channel:'read'）：content 是 {watermark} JSON → 分流給 read 監聽器。
      // 走同一條可靠 + E2EE gossip 管線；聚合單調冪等（見 readReceipts.ts），亂序仍收斂。
      if (gossipMessage.channel === 'read') {
        if (gossipMessage.senderId === this.meshUserId) return; // 自己的回音（本機已樂觀套用）
        try {
          const { watermark } = JSON.parse(gossipMessage.content) as { watermark: string };
          if (typeof watermark !== 'string') return;
          const ev: ReadEvent = { from: gossipMessage.senderId, watermark };
          this.readListeners.forEach((l) => {
            try { l(ev); } catch (error) { logger.error('[MeshChatService] Error in read listener', { error }); }
          });
        } catch {
          logger.warn('[MeshChatService] malformed read receipt ignored', { roomId: this.roomId, seq: gossipMessage.seq });
        }
        return;
      }
      // 通道分流（M4）：非 chat 通道（如 'keyx'）不進聊天顯示。
      if (gossipMessage.channel !== undefined && gossipMessage.channel !== 'chat') return;

      // 過濾自己的回音：anti-entropy / gossip 可能把本機訊息繞回；本機已樂觀顯示。
      // 必須比 mesh userId（senderId 的實際型別），比 firebase uid 永不命中。
      if (gossipMessage.senderId === this.meshUserId) return;

      // 轉換為 ChatMessage。id 優先用寄件端的應用層 id（簽章保護）：
      // 同一則訊息可能同時經 mesh 與 Firestore 備援到達，同 id 才能被 UI 去重。
      const chatMessage: ChatMessage = {
        messageId: gossipMessage.messageId ?? `${gossipMessage.senderId}-${gossipMessage.seq}`,
        from: gossipMessage.senderId,
        content: gossipMessage.content,
        timestamp: gossipMessage.timestamp,
      };

      this.chatStorage.saveChatMessage(chatMessage, this.roomId).catch(error => {
        logger.error('[MeshChatService] Failed to save message to IndexedDB', { error });
      });

      // 通知監聽器
      this.messageListeners.forEach(listener => {
        try {
          listener(chatMessage);
        } catch (error) {
          logger.error('[MeshChatService] Error in message listener', { error });
        }
      });
    });
  }

  /**
   * 發送訊息
   */
  async sendMessage(content: string, providedMessageId?: string): Promise<string> {
    // 呼叫端可傳入 id，讓樂觀顯示與本機自我 emit 共用同一 id（去重收斂）。
    // 未傳入時自生：自增 counter 避免同一毫秒內多則訊息 ID 碰撞。
    const messageId = providedMessageId ?? `${this.localUid}-${Date.now()}-${++this.messageCounter}`;

    // 時戳只取一次：同時給線上複本與本機回音，兩端 orderKey 一致（已讀水位跨端比對需此）。
    const timestamp = Date.now();
    // id 一併進 gossip payload：收端跨傳輸路徑（mesh / Firestore 備援）以同 id 去重
    await this.meshGossipManager.sendMessage(content, messageId, undefined, timestamp);

    // 建立 ChatMessage（用於本地顯示）
    const chatMessage: ChatMessage = {
      messageId,
      from: this.localUid,
      content,
      timestamp,
    };

    await this.chatStorage.saveChatMessage(chatMessage, this.roomId);

    // 通知本地監聽器
    this.messageListeners.forEach(listener => listener(chatMessage));

    return messageId;
  }

  /**
   * 送 typing 暫態信號（lossy，走 mesh presence 通道，不進 gossip 日誌）。
   * best-effort：失敗吞掉，下次 keystroke 再送。對齊星型 ChatService.sendTyping。
   */
  async sendTyping(isTyping: boolean): Promise<void> {
    try {
      await this.meshGossipManager.broadcastTyping(isTyping);
    } catch {
      /* typing 是 best-effort */
    }
  }

  /** 監聽 peer 的 typing（{userId,isTyping}，對齊星型 ChatService.onTyping） */
  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void {
    return this.meshGossipManager.onTyping(listener);
  }

  /**
   * 送遊戲事件 envelope（M4 channel:'game'，走可靠 gossip 管線）。
   * envelope.id 作 messageId 貫穿去重。供 MeshGameBus 轉接 TicTacToe 用。
   */
  async sendGameEnvelope(env: P2PEnvelope): Promise<void> {
    await this.meshGossipManager.sendMessage(JSON.stringify(env), env.id, 'game');
  }

  /** 監聽遊戲事件（channel:'game' 的 P2PEnvelope）；聊天/keyx 不會進來 */
  onGameMessage(listener: (env: P2PEnvelope) => void): () => void {
    this.gameListeners.add(listener);
    return () => {
      this.gameListeners.delete(listener);
    };
  }

  /**
   * 送表情 reaction（channel:'reaction'，走可靠 + E2EE gossip 管線）。
   * 對某訊息加/移除某表情；聚合冪等（見 reactions.ts），亂序到達仍收斂。
   */
  async sendReaction(messageId: string, emoji: string, op: ReactionOp): Promise<void> {
    const payload = JSON.stringify({ messageId, emoji, op });
    // reaction id 綁 (訊息,表情,人,op)：同一 toggle 動作跨傳輸路徑去重
    const id = `rx-${messageId}-${emoji}-${this.meshUserId ?? this.localUid}-${op}`;
    await this.meshGossipManager.sendMessage(payload, id, 'reaction');
  }

  /** 監聽表情 reaction 事件（channel:'reaction'）。 */
  onReaction(listener: (r: ReactionEvent) => void): () => void {
    this.reactionListeners.add(listener);
    return () => {
      this.reactionListeners.delete(listener);
    };
  }

  /**
   * 送已讀水位（channel:'read'，走可靠 + E2EE gossip 管線）。
   * watermark 是單調遞增的 orderKey；固定 messageId（rd-<我>）讓跨傳輸路徑對同一人去重，
   * gossip 協議層仍以 (senderId, seq) 區分每次更新，故新水位照樣傳播。聚合取 max（見
   * readReceipts.ts），亂序/重送安全。呼叫端請只在水位「前進」時送並節流。
   */
  async sendRead(watermark: string): Promise<void> {
    const payload = JSON.stringify({ watermark });
    const id = `rd-${this.meshUserId ?? this.localUid}`;
    await this.meshGossipManager.sendMessage(payload, id, 'read');
  }

  /** 監聽已讀水位事件（channel:'read'）。 */
  onRead(listener: (r: ReadEvent) => void): () => void {
    this.readListeners.add(listener);
    return () => {
      this.readListeners.delete(listener);
    };
  }

  /** 本機 mesh userId（reaction/去重的「我」；initialize 後才有值）。 */
  getMeshUserId(): string | null {
    return this.meshUserId;
  }

  /** 加密狀態（ADR-0026 R2）：encrypted / exchanging / plaintext（真降級）。 */
  getEncryptionState(): EncryptionState {
    return this.meshGossipManager.getEncryptionState();
  }

  /**
   * 備援層加密（ADR-0023 P2-③：mesh 房 Firestore 備援不再明文）。
   * 用房間金鑰把明文加成 RecordCrypto 信封，映射成 FallbackEncryptedContent。
   * 無金鑰回 null → 呼叫端「不送明文橋接」（等 keyx 或靠 anti-entropy 補）。
   */
  async encryptForFallback(content: string): Promise<FallbackEncryptedContent | null> {
    const env = await this.meshGossipManager.encryptForFallback(content);
    if (!env) return null;
    const p = JSON.parse(env) as { ct: string; iv: string; ep: number };
    return { ciphertext: p.ct, iv: p.iv, senderKeyEpoch: p.ep, seq: 0 };
  }

  /** 解備援層密文（房間金鑰）。senderId 未用（房間金鑰非 per-sender），保留簽名相容。 */
  async decryptFromFallback(payload: FallbackEncryptedContent, _senderId: string): Promise<string> {
    const env = JSON.stringify({
      v: 'nrec1', ct: payload.ciphertext, iv: payload.iv, ep: payload.senderKeyEpoch,
    });
    return this.meshGossipManager.decryptForFallback(env);
  }

  /**
   * 載入歷史訊息
   */
  async loadHistory(): Promise<ChatMessage[]> {
    return await this.chatStorage.getChatMessages(this.roomId);
  }

  /**
   * 監聽訊息
   */
  onMessage(listener: (message: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * 獲取連線狀態
   */
  getConnectionState(): 'idle' | 'connecting' | 'connected' | 'failed' | 'closed' {
    if (!this.meshGossipManager.isInitialized()) {
      return 'idle';
    }
    
    const state = this.meshGossipManager.getConnectionState();
    
    // 如果有至少 1 個已連線的鄰居，視為已連線
    // 這樣可以確保即使部分連線失敗，整體仍可運作
    if (state.neighborCount > 0) {
      return 'connected';
    } else if (state.totalNeighbors > 0) {
      return 'connecting';
    } else {
      return 'idle';
    }
  }

  /**
   * mesh 覆蓋狀況：connected=已連上的鄰居數、known=已發現的鄰居數（含未連上）、
   * targetNeighbors=拓撲目標鄰居數 k（Spec 011；partial mesh 下 k < n-1 是設計常態）。
   * 呼叫端的橋接條件應以 min(n-1, targetNeighbors) 為期望值，
   * 否則 partial mesh 房會每訊息觸發備援雙寫（Q4 拍板）。
   */
  getMeshCoverage(): { connected: number; known: number; targetNeighbors?: number } {
    const s = this.meshGossipManager.getConnectionState();
    return {
      connected: s.neighborCount,
      known: s.totalNeighbors,
      ...(s.targetNeighbors !== undefined ? { targetNeighbors: s.targetNeighbors } : {}),
    };
  }

  /**
   * 清理資源
   */
  async cleanup(): Promise<void> {
    await this.meshGossipManager.cleanup();
    this.messageListeners.clear();
    this.gameListeners.clear();
  }
}
