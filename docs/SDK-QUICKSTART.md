# Nerilo SDK — Quickstart（可嵌入聊天/已讀/表情技術）

把 Nerilo 的 P2P mesh 聊天、端到端加密、已讀人數、表情反應，當成一顆技術嵌進你自己的
系統。你只依賴 `src/sdk` 匯出的 **穩定 API**（`NeriloClient` + 型別 + 純邏輯）；內部的
mesh / gossip / crypto 不列入契約、會持續重構。

> **成熟度**：目前是 **P1（地基）**。門面與契約已定，預設後端仍是 Firestore（需要一個已
> 初始化的 Firebase 環境）。P2 會把 signaling / auth 改成可注入，屆時同一份 `NeriloClient`
> 程式碼可換上自架 WebSocket 等後端而 **API 不變**。詳見 [ADR-0025](adr/0025-embeddable-sdk.md)。

## 安裝（現況：源碼層套件）

`package.json` 已設 `exports`，可從套件根或 `/sdk` 進入（源碼層，TS 消費者）：

```ts
import { NeriloClient, createFirestoreChatClient, type ChatMessage } from 'nerilo'
// 或 'nerilo/sdk'
```

這顆 barrel 的**靜態圖無 Firebase**：`NeriloClient`、純 reducer、`InMemory*` 參考 adapter、
型別都可在**無 Firebase** 環境 import 使用；只有 `createFirestoreChatClient` 會（動態）拉
Firestore。（可 `npm publish` 的 dist build 為 P3-final，見 [ADR-0025](adr/0025-embeddable-sdk.md)。）

## 30 秒上手

```ts
// 前提：你的 app 已初始化 Firebase（P1 限制），且已取得使用者 uid。
const client = await createFirestoreChatClient({ roomId: 'room-123', userId: myUid })

// 1) 連線 + 收訊
client.onMessage((msg: ChatMessage) => {
  const { text, replyTo } = client.decode(msg)   // 解出顯示文字（回覆會嵌入被回覆 id）
  render(msg.from, text, replyTo)
})
await client.connect()

// 2) 送訊 / 回覆
await client.sendMessage('哈囉')
await client.sendMessage('收到', someMessageId)   // 第二參數 = 回覆某則

// 3) 表情（toggle：已按會移除）
await client.react(someMessageId, '👍')
client.reactionsFor(someMessageId)               // → [{ emoji:'👍', count:1, mine:true }]

// 4) 已讀人數
client.markReadUpTo(currentlyVisibleMessages)    // 我看到最新 → 廣播已讀水位（只前進才送）
client.readCountFor(myMessage)                    // → 幾位其他成員已讀過這則

// 5) 輸入中
await client.setTyping(true)
client.onTyping(({ userId, isTyping }) => showTyping(userId, isTyping))

// 6) 收工
await client.dispose()
```

## API 摘要

| 方法 | 作用 |
|---|---|
| `connect()` / `dispose()` | 建立連線 / 退訂並關閉 |
| `get userId` | 本機 mesh 身分（connect 後有值） |
| `sendMessage(text, replyToId?)` | 送訊 / 回覆，回傳 messageId |
| `onMessage(cb)` / `loadHistory()` | 收訊 / 載入歷史 |
| `decode(msg)` | 解出 `{ text, replyTo? }` |
| `react(id, emoji)` / `reactionsFor(id)` | 表情 toggle / 聚合 |
| `markReadUpTo(msgs)` / `readCountFor(msg)` | 廣播已讀水位 / 查已讀人數 |
| `setTyping(b)` / `onTyping(cb)` | 輸入中 |

## 進階：自建 UI 聚合

若你要接自己的狀態管理，可直接用出口的**純 reducer**（零依賴、可測），不透過門面：

```ts
import { applyRead, readCount, orderKeyOf, applyReaction } from 'nerilo/src/sdk'
```

## 進階：替換後端（P2 已可用）

**signaling**（P2a）與**節點發現 directory**（P2b）兩道縫都可注入，省略即走 Firestore。
附零 Firebase 的記憶體參考實作，也是自架後端的形狀：

```ts
import {
  createFirestoreChatClient,
  InMemorySignalingHub, InMemorySignalingTransport,
  InMemoryRoomDirectoryHub, InMemoryRoomDirectory,
} from 'nerilo/src/sdk'

const sig = new InMemorySignalingHub()    // 換成你的 WebSocket 匯流排
const dir = new InMemoryRoomDirectoryHub() // 換成你的名冊/發現後端

const client = await createFirestoreChatClient({
  roomId, userId,
  signaling: (r, ch) => new InMemorySignalingTransport(sig, r, ch),
  directory: new InMemoryRoomDirectory(dir, roomId, userId),
})
```

> **界線（誠實）**：signaling + discovery + auth（uid 直接注入）都已脫離 Firebase；
> **storage** 仍走 IndexedDB 預設。另外 `config/firebase` 讀 `import.meta.env`，且預設
> adapter 仍被核心圖靜態 import → 在**非 Vite 環境** import 核心仍會拉到 firebase。要讓
> 「連 import 都不碰 Firebase」需 **P3** 的 import 隔離 + 打包。見
> [ADR-0025](adr/0025-embeddable-sdk.md)。
