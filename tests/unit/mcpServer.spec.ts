/**
 * Nerilo MCP server 整合測試（Spec 008 V1-V4）。
 *
 * 用官方 SDK 的 InMemoryTransport 接「真的 MCP client」呼叫工具——不是 mock server，
 * 走完整 JSON-RPC 協議層。驗證：意圖工具、能力自述、跨 agent runtime 互通、
 * cursor 與 policy 拒絕語義。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type NeriloMcp } from '../../mcp/server';
import { InProcessMcpRuntime } from '../../mcp/inProcessRuntime';
import { InProcessRoomHub } from '../../mcp/inProcessEngine';

let mcp: NeriloMcp;
let client: Client;
let hub: InProcessRoomHub;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return { payload: JSON.parse(text), isError: res.isError === true };
};

beforeEach(async () => {
  hub = new InProcessRoomHub();
  mcp = buildServer({ runtime: new InProcessMcpRuntime('agent-test', hub) });
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  await mcp.dispose();
});

describe('Nerilo MCP server（真 client 經 InMemoryTransport）', () => {
  it('V1：七個意圖工具，含能力自述且不暴露身分冒用參數', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'nerilo_create_room',
      'nerilo_get_capabilities',
      'nerilo_get_messages',
      'nerilo_join_room',
      'nerilo_list_rooms',
      'nerilo_room_status',
      'nerilo_send_message',
    ]);
    for (const t of tools) expect(t.description, `${t.name} 需有說明`).toBeTruthy();
    const sendSchema = tools.find((tool) => tool.name === 'nerilo_send_message')!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(sendSchema.properties).not.toHaveProperty('as');

    const capabilities = await call('nerilo_get_capabilities');
    expect(capabilities.payload).toMatchObject({
      agentId: 'agent-test',
      runtime: 'in-process',
      networked: false,
      persistent: false,
      e2ee: false,
    });
  });

  it('V2：create_room → send_message → get_messages 往返一致', async () => {
    const created = await call('nerilo_create_room');
    expect(created.isError).toBe(false);
    const roomId = created.payload.roomId as string;

    const sent = await call('nerilo_send_message', { roomId, text: 'hello from agent' });
    expect(sent.isError).toBe(false);
    expect(sent.payload.messageId).toBeTruthy();

    const got = await call('nerilo_get_messages', { roomId });
    expect(got.payload.count).toBe(1);
    expect(got.payload.messages[0]).toMatchObject({ from: 'agent-test', text: 'hello from agent' });
  });

  it('V3：兩台固定身分 MCP server 共用 runtime hub，能跨 agent 收發', async () => {
    const { payload } = await call('nerilo_create_room');
    const roomId = payload.roomId as string;

    await call('nerilo_send_message', { roomId, text: '主身分的話' });

    const bobMcp = buildServer({ runtime: new InProcessMcpRuntime('bob', hub) });
    const bobClient = new Client({ name: 'bob-client', version: '0.0.0' });
    const [bobClientT, bobServerT] = InMemoryTransport.createLinkedPair();
    await Promise.all([bobMcp.server.connect(bobServerT), bobClient.connect(bobClientT)]);
    const bobCall = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await bobClient.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      return { payload: JSON.parse(text), isError: res.isError === true };
    };

    try {
      await bobCall('nerilo_join_room', { roomId });
      const bobRead = await bobCall('nerilo_get_messages', { roomId });
      expect(bobRead.payload.messages[0]).toMatchObject({ from: 'agent-test', text: '主身分的話' });
      await bobCall('nerilo_send_message', { roomId, text: 'bob 的話' });

      const got = await call('nerilo_get_messages', { roomId });
      const texts = (got.payload.messages as Array<{ from: string; text: string }>).map((message) => `${message.from}:${message.text}`);
      expect(texts).toEqual(expect.arrayContaining(['agent-test:主身分的話', 'bob:bob 的話']));
    } finally {
      await bobClient.close();
      await bobMcp.dispose();
    }
  });

  it('V4：join 不存在的房 → 明確錯誤非 crash；未 join 就 send 也明確錯誤', async () => {
    const joined = await call('nerilo_join_room', { roomId: 'no-such-room' });
    expect(joined.isError).toBe(true);
    expect(joined.payload.error).toMatch(/不存在/);

    const sent = await call('nerilo_send_message', { roomId: 'no-such-room', text: 'x' });
    expect(sent.isError).toBe(true);
    expect(sent.payload.error).toMatch(/尚未加入/);
  });

  it('list_rooms 反映已加入的房', async () => {
    const a = await call('nerilo_create_room');
    const b = await call('nerilo_create_room');
    const { payload } = await call('nerilo_list_rooms');
    const ids = (payload.rooms as Array<{ roomId: string }>).map((r) => r.roomId);
    expect(ids).toContain(a.payload.roomId);
    expect(ids).toContain(b.payload.roomId);
  });

  it('cursor 只回傳游標之後的訊息', async () => {
    const { payload } = await call('nerilo_create_room');
    const roomId = payload.roomId as string;
    await call('nerilo_send_message', { roomId, text: 'one' });
    const first = await call('nerilo_get_messages', { roomId });
    await call('nerilo_send_message', { roomId, text: 'two' });
    const next = await call('nerilo_get_messages', { roomId, cursor: first.payload.nextCursor });
    expect(next.payload.messages).toHaveLength(1);
    expect(next.payload.messages[0].text).toBe('two');
  });

  it('read-only policy 拒絕所有外部寫入，但允許查 capabilities', async () => {
    const readOnlyMcp = buildServer({
      runtime: new InProcessMcpRuntime('observer', hub),
      policy: { readOnly: true },
    });
    const observer = new Client({ name: 'observer', version: '0.0.0' });
    const [observerT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([readOnlyMcp.server.connect(serverT), observer.connect(observerT)]);
    try {
      const denied = await observer.callTool({ name: 'nerilo_create_room', arguments: {} });
      expect(denied.isError).toBe(true);
      const capabilities = await observer.callTool({ name: 'nerilo_get_capabilities', arguments: {} });
      expect(capabilities.isError).not.toBe(true);
    } finally {
      await observer.close();
      await readOnlyMcp.dispose();
    }
  });
});
