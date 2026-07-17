/**
 * Nerilo MCP server（Spec 008 PoC）— AI agent 的意圖介面。
 *
 * 六個意圖工具（稽核 §5：5-8 甜蜜點、{service}_{action}_{resource} 命名、機制不外露）：
 *   nerilo_create_room / nerilo_join_room / nerilo_send_message /
 *   nerilo_get_messages / nerilo_room_status / nerilo_list_rooms
 *
 * SessionManager 解決「MCP 工具是無狀態呼叫、NeriloClient 是有狀態物件」的落差：
 * roomId → 已 connect 的 NeriloClient；訊息經 onMessage 進 per-room 緩衝。
 * 引擎為行程內 InProcessChatEngine（見該檔誠實邊界）；門面 NeriloClient 原封不動——
 * 這正是「第三方自帶引擎接上門面」的可執行證明。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NeriloClient } from '../src/sdk/index';
import type { ChatMessage } from '../src/types';
import { InProcessChatEngine, InProcessRoomHub } from './inProcessEngine';

interface Session {
  client: NeriloClient;
  userId: string;
  inbox: ChatMessage[];
}

export interface NeriloMcp {
  server: McpServer;
  dispose(): Promise<void>;
}

let roomSeq = 0;
const newRoomId = () => `room-${Date.now().toString(36)}-${(++roomSeq).toString(36)}`;

const ok = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

export function buildServer(agentId = `agent-${Math.random().toString(36).slice(2, 8)}`): NeriloMcp {
  const hub = new InProcessRoomHub();
  const sessions = new Map<string, Session>();

  async function join(roomId: string, userId: string): Promise<Session> {
    const existing = sessions.get(roomId);
    if (existing) return existing;
    const client = new NeriloClient(new InProcessChatEngine(hub, roomId, userId));
    const session: Session = { client, userId, inbox: [] };
    client.onMessage((m) => session.inbox.push(m));
    await client.connect();
    sessions.set(roomId, session);
    return session;
  }

  const server = new McpServer({ name: 'nerilo', version: '0.1.0' });

  server.registerTool(
    'nerilo_create_room',
    {
      description: '建立一個新聊天房間並加入。回傳 roomId，之後用它收發訊息。',
      inputSchema: { name: z.string().optional().describe('房間顯示名稱（可省略）') },
    },
    async () => {
      const roomId = newRoomId();
      await join(roomId, agentId);
      return ok({ roomId, joined: true });
    }
  );

  server.registerTool(
    'nerilo_join_room',
    {
      description: '加入既有房間（需已知 roomId，例如另一個 session 建立的）。',
      inputSchema: {
        roomId: z.string().describe('要加入的房間 id'),
        as: z.string().optional().describe('以哪個身分加入（省略＝本 agent 身分）'),
      },
    },
    async ({ roomId, as }) => {
      if (!hub.has(roomId)) return fail(`房間不存在：${roomId}（先用 nerilo_create_room 建立）`);
      if (sessions.has(roomId) && as && sessions.get(roomId)!.userId !== as) {
        // 同房第二身分：另開 client（行程內多 session 互通的示範用法）
        const client = new NeriloClient(new InProcessChatEngine(hub, roomId, as));
        const session: Session = { client, userId: as, inbox: [] };
        client.onMessage((m) => session.inbox.push(m));
        await client.connect();
        sessions.set(`${roomId}::${as}`, session);
        return ok({ roomId, joined: true, as });
      }
      await join(roomId, as ?? agentId);
      return ok({ roomId, joined: true, as: as ?? agentId });
    }
  );

  server.registerTool(
    'nerilo_send_message',
    {
      description: '在已加入的房間送出一則訊息。回傳 messageId。',
      inputSchema: {
        roomId: z.string(),
        text: z.string().min(1).describe('訊息內容'),
        as: z.string().optional().describe('以哪個身分送（需先以該身分 join）'),
      },
    },
    async ({ roomId, text, as }) => {
      const key = as && sessions.has(`${roomId}::${as}`) ? `${roomId}::${as}` : roomId;
      const session = sessions.get(key);
      if (!session) return fail(`尚未加入房間：${roomId}（先 nerilo_join_room）`);
      const messageId = await session.client.sendMessage(text);
      return ok({ messageId });
    }
  );

  server.registerTool(
    'nerilo_get_messages',
    {
      description: '取得房間訊息（歷史＋新到），依時間排序。',
      inputSchema: {
        roomId: z.string(),
        limit: z.number().int().positive().max(200).optional().describe('最多回傳幾則（預設 50）'),
      },
    },
    async ({ roomId, limit }) => {
      const s = sessions.get(roomId);
      if (!s) return fail(`尚未加入房間：${roomId}（先 nerilo_join_room）`);
      const history = await s.client.loadHistory();
      const seen = new Set<string>();
      const merged = [...history, ...s.inbox]
        .filter((m) => (seen.has(m.messageId) ? false : (seen.add(m.messageId), true)))
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-(limit ?? 50))
        .map((m) => ({ messageId: m.messageId, from: m.from, text: s.client.decode(m).text, timestamp: m.timestamp }));
      return ok({ roomId, count: merged.length, messages: merged });
    }
  );

  server.registerTool(
    'nerilo_room_status',
    {
      description: '查房間狀態：我的身分、訊息數、已知成員。',
      inputSchema: { roomId: z.string() },
    },
    async ({ roomId }) => {
      const session = sessions.get(roomId);
      if (!session) return fail(`尚未加入房間：${roomId}`);
      const history = await session.client.loadHistory();
      const members = [...new Set(history.map((m) => m.from))];
      return ok({ roomId, me: session.client.userId, messageCount: history.length, members });
    }
  );

  server.registerTool(
    'nerilo_list_rooms',
    {
      description: '列出本 server 已加入的房間。',
      inputSchema: {},
    },
    async () => {
      const rooms = [...sessions.entries()]
        .filter(([key]) => !key.includes('::'))
        .map(([roomId, s]) => ({ roomId, me: s.userId, inboxCount: s.inbox.length }));
      return ok({ rooms });
    }
  );

  return {
    server,
    async dispose() {
      for (const s of sessions.values()) await s.client.dispose();
      sessions.clear();
    },
  };
}
