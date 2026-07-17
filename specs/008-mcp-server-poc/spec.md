# Spec 008：Nerilo MCP server PoC — AI agent 的意圖介面

- 軌別：feature（新公開表面：MCP 工具集）
- 狀態：done（2026-07-16，MCP 整合測試 5/5、全閘門綠）
- 建立：2026-07-16
- 關聯：架構收斂稽核 §5（MCP 映射）、ADR-0025（SDK）、憲法 §14

## 1. 要做什麼、為什麼（specify）

把 Nerilo 的能力以 MCP（Model Context Protocol）工具形式暴露給 AI agent，證明「可嵌入層」對第三種消費者（agent）也成立。稽核 §5 已定調：MCP 是給 agent 的**意圖介面**，不是 API 窮舉；工具照使用者意圖切、每台 server 5-8 個工具。本 PoC 交付一台可被 Claude Code / Claude Desktop 掛載的 stdio MCP server，讓 agent 能建房、加入、收發訊息、查狀態。

**憲法檢核**：
- 目標函數加分項：可嵌入（第三種消費者實證）；補助競爭力（AI agent 對接是差異化敘事）。
- 四條不變量影響：皆〈無〉——PoC 用行程內引擎，不碰 mesh/crypto/帳本路徑。

## 2. 邊界（明確不做）

- **不在 Node 硬撐真 WebRTC mesh**：Node 無 RTCPeerConnection/IndexedDB，wrtc 原生依賴重且脆。真網路對接（browser bridge 或 node-datachannel）列 follow-up，不進 PoC。
- 不做多 server 跨行程互通（那是真網路的事）。
- 不暴露機制工具（signaling/keyx/courier/ledger 不是工具——稽核 §5 裁決）。
- 不進 npm 發佈包（`mcp/` 不在 `files` 內；PoC 以 repo 內腳本交付）。

## 3. 待釐清（clarify）——2026-07-16 依稽核裁決代決，標註供追認

- [x] Q1 工具清單：稽核 §5 的六個——`nerilo_create_room` / `nerilo_join_room` / `nerilo_send_message` / `nerilo_get_messages` / `nerilo_room_status` / `nerilo_list_rooms`（5-8 甜蜜點內）。
- [x] Q2 引擎：**行程內 `InProcessChatEngine` 實作 `IChatEngine`**，接上 `NeriloClient` 門面——用 SDK 自己的縫，本身即「第三方可換引擎」的活證明。誠實標注：訊息傳遞在行程內，非真 P2P。
- [x] Q3 傳輸：stdio（Claude Code/Desktop 標準掛載方式）；測試用 SDK 的 InMemoryTransport 對接真 client。

## 4. 技術計畫（plan）

- `mcp/inProcessEngine.ts`：`IChatEngine` 純實作＋行程內房間匯流排（Map<roomId, {messages, listeners}>）；同房多 session 即時互通、loadHistory 回放。零外部依賴、可單元測。
- `mcp/server.ts`：`buildServer()` 建 McpServer＋六工具；SessionManager（roomId → NeriloClient）管生命週期（MCP 工具無狀態呼叫 ↔ client 有狀態，這是稽核點名的主要工作）；訊息經 onMessage 進 per-room 緩衝，`get_messages` 吐緩衝＋歷史。工具 schema 用 zod、錯誤語義明確（房不存在／未加入）。
- `mcp/main.ts`：stdio 進入點。
- 依賴：`@modelcontextprotocol/sdk` + `zod`（devDependencies，不進發佈包）。
- 驗證：vitest 用 InMemoryTransport 接真 MCP client 呼叫工具（不是 mock server）。

## 5. 任務分解（tasks）

- [x] T1：InProcessChatEngine + 房間匯流排（單元：同房兩 session 互通、歷史回放）。
- [x] T2：buildServer 六工具 + SessionManager + zod schema + 錯誤語義。
- [x] T3：MCP 整合測試（真 client 經 InMemoryTransport：list tools=6、create→send→get 往返、join 第二 session 收到第一 session 的訊息、未知房錯誤）。
- [x] T4：stdio 進入點 + npm script + 掛載說明（claude mcp add）。

## 6. 驗收（黃金判準）

- [x] V1：真 MCP client 列出恰好 6 個工具，名稱全為 `nerilo_{action}_{resource}` 意圖式。
- [x] V2：create_room → send_message → get_messages 往返，內容一致。
- [x] V3：兩個 session 加入同房，A 送的訊息 B 的 get_messages 拿得到（行程內互通）。
- [x] V4：join 不存在的房 → 明確錯誤（非 crash）。
- [x] V5：既有全部閘門不受影響（type-check/unit/lint/發佈包內容不變）。

## 7. 一致性自查（analyze）

- [x] 方案覆蓋需求、無多做
- [x] 任務完整實現方案
- [x] 驗收能證明需求
- [x] 未違反憲法任何一條
