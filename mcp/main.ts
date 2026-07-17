/**
 * Nerilo MCP server stdio 進入點（Spec 008）。
 * 掛載（Claude Code）：claude mcp add nerilo -- npx tsx mcp/main.ts
 * （或先 esbuild bundle 再以 node 執行；PoC 以 tsx 直跑最簡。）
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server';

const { server } = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
