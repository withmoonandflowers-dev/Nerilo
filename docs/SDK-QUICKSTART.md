# Nerilo SDK — Quickstart（可嵌入聊天/已讀/表情技術）

把 Nerilo 的 P2P mesh 聊天、端到端加密、已讀人數、表情反應，當成一顆技術嵌進你自己的
系統。你只依賴 `src/sdk` 匯出的 **穩定 API**（`NeriloClient` + 型別 + 純邏輯）；內部的
mesh / gossip / crypto 不列入契約、會持續重構。

> **成熟度**：目前是 **P1（地基）**。門面與契約已定，預設後端仍是 Firestore（需要一個已
> 初始化的 Firebase 環境）。P2 會把 signaling / auth 改成可注入，屆時同一份 `NeriloClient`
> 程式碼可換上自架 WebSocket 等後端而 **API 不變**。詳見 [ADR-0025](adr/0025-embeddable-sdk.md)。

## 安裝（P1 現況）

SDK 尚未獨立發包；先以原始碼形式引用出口 barrel：

```ts
import {
  createFirestoreChatClient,
  type ChatMessage,
} from 'nerilo/src/sdk'
```

（P2 會補上 `package.json` 的 `exports` 與 build，變成 `import { NeriloClient } from '@nerilo/sdk'`。）

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

## 進階：替換 signaling 後端（P2a 已可用）

signaling 這道縫已可注入。`createFirestoreChatClient` 收選填 `signaling: SignalingFactory`
（`(roomId, channelLabel) => SignalingTransport`）；省略即走 Firestore。附一顆無 Firebase 的
記憶體參考實作，也是自架 WebSocket 後端的形狀：

```ts
import { createFirestoreChatClient, InMemorySignalingHub, InMemorySignalingTransport } from 'nerilo/src/sdk'

const hub = new InMemorySignalingHub()   // 換成你的 WebSocket 匯流排即可
const client = await createFirestoreChatClient({
  roomId, userId,
  signaling: (roomId, channelLabel) => new InMemorySignalingTransport(hub, roomId, channelLabel),
})
```

> **P2a 界線（誠實）**：目前只有 **signaling** 可注入；**節點發現（discovery）** 與
> **storage** 仍走 Firestore。要「完全不吞 Firebase」需等 P2b 把 discovery/auth 抽成
> `IRoomDirectory`/`IAuthProvider` port。見 [ADR-0025](adr/0025-embeddable-sdk.md)。
