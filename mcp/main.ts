/**
 * Nerilo MCP server stdio 進入點（Spec 008）。
 * 掛載（MCP 客戶端）：在客戶端設定中指向 npx tsx mcp/main.ts
 * （或先 esbuild bundle 再以 node 執行；PoC 以 tsx 直跑最簡。）
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server';

const allowedRoomIds = process.env['NERILO_MCP_ALLOWED_ROOMS']
  ? new Set(process.env['NERILO_MCP_ALLOWED_ROOMS']!.split(',').map((value) => value.trim()).filter(Boolean))
  : undefined;
const maxMessageChars = Number(process.env['NERILO_MCP_MAX_MESSAGE_CHARS'] ?? 4_000);

const { server } = buildServer({
  agentId: process.env['NERILO_MCP_AGENT_ID'],
  policy: {
    readOnly: process.env['NERILO_MCP_READ_ONLY'] === 'true',
    allowCreateRoom: process.env['NERILO_MCP_ALLOW_CREATE'] !== 'false',
    allowJoinRoom: process.env['NERILO_MCP_ALLOW_JOIN'] !== 'false',
    allowedRoomIds,
    maxMessageChars: Number.isSafeInteger(maxMessageChars) && maxMessageChars > 0
      ? maxMessageChars
      : 4_000,
  },
  // stdio transport 的 stdout 必須保留給 JSON-RPC；稽核事件只能走 stderr。
  audit: (event) => process.stderr.write(`${JSON.stringify({ source: 'nerilo-mcp', ...event })}\n`),
});
const transport = new StdioServerTransport();
await server.connect(transport);
