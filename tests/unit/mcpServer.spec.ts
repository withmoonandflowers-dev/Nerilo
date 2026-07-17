/**
 * Nerilo MCP server 整合測試（Spec 008 V1-V4）。
 *
 * 用官方 SDK 的 InMemoryTransport 接「真的 MCP client」呼叫工具——不是 mock server，
 * 走完整 JSON-RPC 協議層。驗證：六工具表面、create→send→get 往返、同房雙 session
 * 行程內互通、未知房明確錯誤。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type NeriloMcp } from '../../mcp/server';

let mcp: NeriloMcp;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return { payload: JSON.parse(text), isError: res.isError === true };
};

beforeEach(async () => {
  mcp = buildServer('agent-test');
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  await mcp.dispose();
});

describe('Nerilo MCP server（真 client 經 InMemoryTransport）', () => {
  it('V1：恰好六個意圖工具，命名 nerilo_{action}_{resource}', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'nerilo_create_room',
      'nerilo_get_messages',
      'nerilo_join_room',
      'nerilo_list_rooms',
      'nerilo_room_status',
      'nerilo_send_message',
    ]);
    for (const t of tools) expect(t.description, `${t.name} 需有說明`).toBeTruthy();
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

  it('V3：同房第二身分加入，A 送的訊息 B 視角拿得到（行程內互通）', async () => {
    const { payload } = await call('nerilo_create_room');
    const roomId = payload.roomId as string;

    await call('nerilo_join_room', { roomId, as: 'bob' });
    await call('nerilo_send_message', { roomId, text: '主身分的話' });
    await call('nerilo_send_message', { roomId, text: 'bob 的話', as: 'bob' });

    const got = await call('nerilo_get_messages', { roomId });
    const texts = (got.payload.messages as Array<{ from: string; text: string }>).map((m) => `${m.from}:${m.text}`);
    expect(texts).toContain('agent-test:主身分的話');
    expect(texts).toContain('bob:bob 的話');

    const status = await call('nerilo_room_status', { roomId });
    expect(status.payload.members).toEqual(expect.arrayContaining(['agent-test', 'bob']));
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
});
