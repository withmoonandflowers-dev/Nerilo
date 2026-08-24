import type { ChatMessage } from '../types';
import type { ReactionEvent, ReactionOp } from '../core/messaging/reactions';
import type { ReadEvent } from '../core/messaging/readReceipts';
import type { NeriloStatus } from '../core/messaging/status';

/**
 * 傳輸中立的聊天引擎契約(SDK 注入縫)。
 *
 * NeriloClient 只依賴這個介面,不綁任何具體後端——現階段預設由既有的 Firestore-backed
 * MeshChatService 結構上滿足(見 sdk/index.ts 的 createFirestoreChatClient);P2 去 Firebase
 * 化後,同一個門面可換上以注入式 SignalingTransport 建的引擎(自架 WebSocket 等)。
 *
 * 只收錄「傳輸中立」的核心能力;Firestore 備援橋接(encryptForFallback 等)刻意不列入,
 * 那是特定後端的細節、不屬公開契約。
 */
export interface IChatEngine {
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  /** 本機 mesh 身分(initialize 後才有值);用於已讀/表情的「我」與去重。 */
  getMeshUserId(): string | null;

  sendMessage(content: string, messageId?: string): Promise<string>;
  onMessage(listener: (message: ChatMessage) => void): () => void;
  loadHistory(): Promise<ChatMessage[]>;

  sendReaction(messageId: string, emoji: string, op: ReactionOp): Promise<void>;
  onReaction(listener: (ev: ReactionEvent) => void): () => void;

  sendRead(watermark: string): Promise<void>;
  onRead(listener: (ev: ReadEvent) => void): () => void;

  sendTyping(isTyping: boolean): Promise<void>;
  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void;

  /**
   * 連線與加密狀態（Spec 024；0.10.0 起為必要方法，自帶引擎需實作——CHANGELOG 有破壞性說明）。
   * getStatus 是同步快照；onStatus 訂閱變更（訂閱當下先收一次目前狀態，之後同值不重發）。
   */
  getStatus(): NeriloStatus;
  onStatus(listener: (s: NeriloStatus) => void): () => void;
}
