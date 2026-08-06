/**
 * Local MCP runtime：供測試、工具探索與單一行程 demo。
 * 誠實邊界由 capabilities 對 AI 公開：無網路、無持久化、無 E2EE、不可跨程序。
 */
import { NeriloClient } from '../src/sdk/index';
import type { ChatMessage } from '../src/types';
import { InProcessChatEngine, InProcessRoomHub } from './inProcessEngine';
import { decodeMessage, type NeriloMcpRuntime } from './runtime';

interface Session {
  client: NeriloClient;
  inbox: ChatMessage[];
}

let roomSeq = 0;
const newRoomId = () => `room-${Date.now().toString(36)}-${(++roomSeq).toString(36)}`;

export class InProcessMcpRuntime implements NeriloMcpRuntime {
  readonly capabilities = {
    runtime: 'in-process',
    networked: false,
    persistent: false,
    e2ee: false,
    crossProcess: false,
    notes: [
      '訊息只存在目前 MCP server 行程記憶體中',
      '不代表 Nerilo WebRTC、Firestore fallback 或 E2EE 已接線',
    ],
  } as const;

  private readonly sessions = new Map<string, Session>();

  constructor(
    readonly agentId: string,
    private readonly hub = new InProcessRoomHub()
  ) {}

  private async connect(roomId: string): Promise<Session> {
    const existing = this.sessions.get(roomId);
    if (existing) return existing;
    const client = new NeriloClient(new InProcessChatEngine(this.hub, roomId, this.agentId));
    const session: Session = { client, inbox: [] };
    client.onMessage((message) => session.inbox.push(message));
    await client.connect();
    this.sessions.set(roomId, session);
    return session;
  }

  async createRoom(_name?: string): Promise<{ roomId: string; joined: true }> {
    const roomId = newRoomId();
    await this.connect(roomId);
    return { roomId, joined: true };
  }

  async joinRoom(roomId: string): Promise<{ roomId: string; joined: true }> {
    if (!this.hub.has(roomId)) throw new Error(`房間不存在：${roomId}`);
    await this.connect(roomId);
    return { roomId, joined: true };
  }

  async sendMessage(roomId: string, text: string, replyToId?: string): Promise<{ messageId: string }> {
    const session = this.sessions.get(roomId);
    if (!session) throw new Error(`尚未加入房間：${roomId}`);
    return { messageId: await session.client.sendMessage(text, replyToId) };
  }

  async getMessages(roomId: string, options: { limit: number; cursor?: string }) {
    const session = this.sessions.get(roomId);
    if (!session) throw new Error(`尚未加入房間：${roomId}`);
    const history = await session.client.loadHistory();
    const seen = new Set<string>();
    const merged = [...history, ...session.inbox]
      .filter((message) => (seen.has(message.messageId) ? false : (seen.add(message.messageId), true)))
      .sort((a, b) => a.timestamp - b.timestamp || a.messageId.localeCompare(b.messageId));

    let start = Math.max(0, merged.length - options.limit);
    if (options.cursor) {
      const cursorIndex = merged.findIndex((message) => message.messageId === options.cursor);
      if (cursorIndex < 0) throw new Error('cursor 不存在或已過期，請省略 cursor 重新讀取');
      start = cursorIndex + 1;
    }
    const page = merged.slice(start, start + options.limit);
    return {
      messages: page.map((message) => decodeMessage(message, (item) => session.client.decode(item))),
      ...(page.length > 0 ? { nextCursor: page[page.length - 1]!.messageId } : {}),
    };
  }

  async roomStatus(roomId: string) {
    const session = this.sessions.get(roomId);
    if (!session) throw new Error(`尚未加入房間：${roomId}`);
    const history = await session.client.loadHistory();
    return {
      roomId,
      me: this.agentId,
      messageCount: history.length,
      members: [...new Set([this.agentId, ...history.map((message) => message.from)])],
    };
  }

  async listRooms() {
    return [...this.sessions.entries()].map(([roomId, session]) => ({
      roomId,
      me: this.agentId,
      inboxCount: session.inbox.length,
    }));
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) await session.client.dispose();
    this.sessions.clear();
  }
}
