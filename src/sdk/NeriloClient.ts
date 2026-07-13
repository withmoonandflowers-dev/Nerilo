import type { ChatMessage, HLCTimestamp } from '../types';
import type { IChatEngine } from './IChatEngine';
import { applyReaction, hasReacted, type ReactionMap } from '../features/chat/reactions';
import { applyRead, readCount, orderKeyOf, type ReadState } from '../features/chat/readReceipts';
import { encodeContent, decodeContent } from '../features/chat/messageContent';

/** 已讀水位比對用的最小訊息形狀(timestamp 必有,hlc 可選)。 */
export interface Positioned {
  timestamp: number;
  hlc?: HLCTimestamp;
}

/**
 * Nerilo 可嵌入門面。
 *
 * 第三方只依賴這個穩定 API:收發訊息、表情、已讀人數、輸入中、生命週期。內部的 mesh /
 * gossip / E2EE 細節、以及表情與已讀水位的聚合(純 reducer)都封裝在此,對外只吐結果。
 * 建構時注入 IChatEngine(預設由 createFirestoreChatClient 提供 Firestore 後端)。
 */
export class NeriloClient {
  private reactions: ReactionMap = {};
  private reads: ReadState = {};
  private myWatermark = ''; // 上次送出的自身已讀水位(只前進才再送,天然限流)
  private disposed = false;
  private unsubs: Array<() => void> = [];

  constructor(private readonly engine: IChatEngine) {}

  /** 建立連線並開始接收訊息/表情/已讀事件。 */
  async connect(): Promise<void> {
    await this.engine.initialize();
    this.unsubs.push(this.engine.onReaction((ev) => { this.reactions = applyReaction(this.reactions, ev); }));
    this.unsubs.push(this.engine.onRead((ev) => { this.reads = applyRead(this.reads, ev); }));
  }

  /** 本機身分(connect 後才有值)。 */
  get userId(): string | null {
    return this.engine.getMeshUserId();
  }

  // ── 訊息 ──────────────────────────────────────────────
  /** 送一則訊息;replyToId 帶入則為回覆(引用資訊隨內容一起加密)。回傳 messageId。 */
  sendMessage(text: string, replyToId?: string): Promise<string> {
    return this.engine.sendMessage(encodeContent(text, replyToId));
  }

  /** 訂閱新訊息(遠端 + 本機回音);回傳退訂函式。 */
  onMessage(cb: (msg: ChatMessage) => void): () => void {
    const unsub = this.engine.onMessage(cb);
    this.unsubs.push(unsub);
    return unsub;
  }

  loadHistory(): Promise<ChatMessage[]> {
    return this.engine.loadHistory();
  }

  /** 解出顯示文字與被回覆 id(回覆訊息會嵌入編碼標記)。 */
  decode(msg: ChatMessage): { text: string; replyTo?: string } {
    return decodeContent(msg.content);
  }

  // ── 表情 ──────────────────────────────────────────────
  /** 對某訊息 toggle 一個表情(已加則移除);樂觀立即反映,並廣播。 */
  async react(messageId: string, emoji: string): Promise<void> {
    const me = this.userId;
    if (!me) return;
    const op = hasReacted(this.reactions, messageId, emoji, me) ? 'remove' : 'add';
    this.reactions = applyReaction(this.reactions, { messageId, emoji, from: me, op });
    await this.engine.sendReaction(messageId, emoji, op);
  }

  /** 某訊息目前的表情聚合(emoji、計數、我是否已按)。 */
  reactionsFor(messageId: string): Array<{ emoji: string; count: number; mine: boolean }> {
    const byEmoji = this.reactions[messageId];
    if (!byEmoji) return [];
    const me = this.userId ?? '';
    return Object.entries(byEmoji).map(([emoji, froms]) => ({
      emoji, count: froms.length, mine: froms.includes(me),
    }));
  }

  // ── 已讀人數 ───────────────────────────────────────────
  /**
   * 標記「我已讀到這批訊息的最高位置」並廣播水位(只在前進時送,天然限流)。
   * 呼叫時機由呼叫端決定(進房、捲到底、在底部收到新訊息)。
   */
  markReadUpTo(messages: Positioned[]): void {
    const me = this.userId;
    if (!me) return;
    let top = '';
    for (const m of messages) {
      const k = orderKeyOf(m);
      if (k > top) top = k;
    }
    if (!top || top <= this.myWatermark) return;
    this.myWatermark = top;
    this.reads = applyRead(this.reads, { from: me, watermark: top }); // 樂觀(自身不計入顯示)
    void this.engine.sendRead(top);
  }

  /** 某則訊息的已讀人數(排除作者本人與我)。 */
  readCountFor(msg: ChatMessage): number {
    const me = this.userId ?? msg.from;
    return readCount(this.reads, orderKeyOf(msg), msg.from, [me]);
  }

  // ── 輸入中 ─────────────────────────────────────────────
  setTyping(isTyping: boolean): Promise<void> {
    return this.engine.sendTyping(isTyping);
  }

  onTyping(cb: (data: { userId: string; isTyping: boolean }) => void): () => void {
    const unsub = this.engine.onTyping(cb);
    this.unsubs.push(unsub);
    return unsub;
  }

  // ── 生命週期 ───────────────────────────────────────────
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs.splice(0)) {
      try { u(); } catch { /* 退訂失敗忽略 */ }
    }
    await this.engine.cleanup();
  }
}
