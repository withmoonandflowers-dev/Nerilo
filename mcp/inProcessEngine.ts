/**
 * InProcessChatEngine — 行程內 IChatEngine 實作（Spec 008 / MCP PoC）。
 *
 * 這是「第三方自帶引擎接上 NeriloClient 門面」的活證明：MCP server（Node 行程）
 * 跑不了瀏覽器 WebRTC，於是用 SDK 的注入縫換引擎——門面 API 一字不改。
 * 訊息傳遞在同一行程內的房間匯流排（同房多 session 即時互通＋歷史回放）。
 * 誠實邊界：非真 P2P、無 E2EE；真網路對接（browser bridge / node-datachannel）是 follow-up。
 */
import type { IChatEngine } from '../src/sdk/index';
import type { ChatMessage } from '../src/types';
import type { ReactionEvent, ReactionOp } from '../src/features/chat/reactions';
import type { ReadEvent } from '../src/features/chat/readReceipts';

interface RoomBus {
  messages: ChatMessage[];
  msgListeners: Set<(m: ChatMessage) => void>;
  reactionListeners: Set<(ev: ReactionEvent) => void>;
  readListeners: Set<(ev: ReadEvent) => void>;
  typingListeners: Set<(d: { userId: string; isTyping: boolean }) => void>;
}

/** 行程內房間註冊表：同一 Map 上的 session 即互通。 */
export class InProcessRoomHub {
  private rooms = new Map<string, RoomBus>();

  room(roomId: string): RoomBus {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = {
        messages: [],
        msgListeners: new Set(),
        reactionListeners: new Set(),
        readListeners: new Set(),
        typingListeners: new Set(),
      };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  list(): string[] {
    return [...this.rooms.keys()];
  }
}

let seq = 0;
const nextId = () => `inproc-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export class InProcessChatEngine implements IChatEngine {
  private disposed = false;
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly hub: InProcessRoomHub,
    private readonly roomId: string,
    private readonly userId: string
  ) {}

  async initialize(): Promise<void> {
    this.hub.room(this.roomId); // 確保房存在
  }

  async cleanup(): Promise<void> {
    this.disposed = true;
    for (const u of this.unsubs.splice(0)) u();
  }

  getMeshUserId(): string | null {
    return this.userId;
  }

  async sendMessage(content: string, messageId?: string): Promise<string> {
    const bus = this.hub.room(this.roomId);
    const msg: ChatMessage = {
      messageId: messageId ?? nextId(),
      from: this.userId,
      content,
      timestamp: Date.now(),
    };
    bus.messages.push(msg);
    for (const l of bus.msgListeners) l(msg);
    return msg.messageId;
  }

  onMessage(listener: (message: ChatMessage) => void): () => void {
    const bus = this.hub.room(this.roomId);
    bus.msgListeners.add(listener);
    const off = () => bus.msgListeners.delete(listener);
    this.unsubs.push(off);
    return off;
  }

  async loadHistory(): Promise<ChatMessage[]> {
    return [...this.hub.room(this.roomId).messages];
  }

  async sendReaction(messageId: string, emoji: string, op: ReactionOp): Promise<void> {
    const bus = this.hub.room(this.roomId);
    const ev: ReactionEvent = { messageId, emoji, from: this.userId, op };
    for (const l of bus.reactionListeners) l(ev);
  }

  onReaction(listener: (ev: ReactionEvent) => void): () => void {
    const bus = this.hub.room(this.roomId);
    bus.reactionListeners.add(listener);
    const off = () => bus.reactionListeners.delete(listener);
    this.unsubs.push(off);
    return off;
  }

  async sendRead(watermark: string): Promise<void> {
    const bus = this.hub.room(this.roomId);
    const ev: ReadEvent = { from: this.userId, watermark };
    for (const l of bus.readListeners) l(ev);
  }

  onRead(listener: (ev: ReadEvent) => void): () => void {
    const bus = this.hub.room(this.roomId);
    bus.readListeners.add(listener);
    const off = () => bus.readListeners.delete(listener);
    this.unsubs.push(off);
    return off;
  }

  async sendTyping(isTyping: boolean): Promise<void> {
    if (this.disposed) return;
    const bus = this.hub.room(this.roomId);
    for (const l of bus.typingListeners) l({ userId: this.userId, isTyping });
  }

  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void {
    const bus = this.hub.room(this.roomId);
    bus.typingListeners.add(listener);
    const off = () => bus.typingListeners.delete(listener);
    this.unsubs.push(off);
    return off;
  }
}
