# Nerilo SDK Quickstart

把端到端加密、點對點直連、斷網送達的即時通訊，嵌進你自己的產品。你只依賴 `NeriloClient` 這個門面，內部的 mesh、gossip、密碼學細節都封裝掉，可自由重構而不動你的程式。

適用環境：瀏覽器（需要 WebRTC 與 SubtleCrypto）。伺服器端 Node 可以匯入型別與純函式，但 `connect()` 要在瀏覽器跑。

完整可跑的範例（同頁兩個 peer、零 Firebase、瀏覽器實測互傳）見 [examples/minimal-chat](../examples/minimal-chat)，根目錄 `npm run example:minimal` 即開。

## 安裝

```bash
npm install nerilo
```

## 30 秒觀念

- **一個門面**：`NeriloClient`，收發訊息、表情、已讀、輸入中、生命週期。
- **四道可注入的縫**：signaling（誰幫忙交換連線資訊）、directory（房間名冊）、storage（本機訊息儲存）、身分（你傳進來的 userId）。全部可替換。
- **省略後端會怎樣**：不注入 signaling/directory/storage 時，`initialize()` 才動態載入預設的 Firestore/IndexedDB。省略者延後載入，代表「全部注入」這條路徑的靜態相依圖裡沒有 Firebase。

## 最小範例（零 Firebase，單頁可跑）

用全記憶體的參考 adapter，不需要任何後端帳號。適合先把 API 跑起來、寫整合測試、或做同頁展示。

```ts
import {
  InMemorySignalingHub,
  InMemorySignalingTransport,
  InMemoryRoomDirectory,
  InMemoryRoomDirectoryHub,
  InMemoryChatStorage,
} from 'nerilo';
import { createChatClient } from 'nerilo/firestore'; // turnkey 工廠在 subpath

// 同一顆 hub 給同頁的多個 client 共用，就能在單一 JS context 內互通。
const sigHub = new InMemorySignalingHub();
const dirHub = new InMemoryRoomDirectoryHub();

const client = await createChatClient({
  roomId: 'demo-room',
  userId: 'alice',
  signaling: (roomId, channelLabel) => new InMemorySignalingTransport(sigHub, roomId, channelLabel),
  directory: new InMemoryRoomDirectory(dirHub, 'demo-room', 'alice'),
  storage: new InMemoryChatStorage(),
});

// 訂閱先接、再連線，才不會漏掉早到的訊息。
const off = client.onMessage((msg) => {
  const { text } = client.decode(msg);
  console.log(`${msg.from}: ${text}`);
});

await client.connect();
await client.sendMessage('hello mesh');

// 收工
off();
await client.dispose();
```

同頁要模擬兩個人對話，就用同一組 `sigHub`／`dirHub` 再建一個 `userId: 'bob'` 的 client。

> 邊界：記憶體 adapter 只在同一個 JS context 內互通。要跨裝置、跨分頁，換成 Firestore 預設或你自己的 signaling 後端（見下一節）。

## 核心 API

| 方法 | 用途 |
|---|---|
| `connect()` | 建立連線並開始接收訊息/表情/已讀 |
| `sendMessage(text, replyToId?)` | 送訊息，可帶回覆對象；回傳 messageId |
| `onMessage(cb)` | 訂閱新訊息（含本機回音）；回傳退訂函式 |
| `decode(msg)` | 解出顯示文字與被回覆 id |
| `loadHistory()` | 載入歷史訊息 |
| `react(messageId, emoji)` | toggle 表情，樂觀更新並廣播 |
| `reactionsFor(messageId)` | 某訊息的表情聚合（emoji、count、mine） |
| `markReadUpTo(messages)` | 標記已讀水位並廣播（只前進時送，天然限流） |
| `readCountFor(msg)` | 某訊息的已讀人數（排除作者與自己） |
| `setTyping(isTyping)` / `onTyping(cb)` | 輸入中狀態 |
| `userId` | 本機身分（connect 後才有值） |
| `dispose()` | 退訂所有事件並清理連線 |

只有這個門面與注入契約算穩定 API。內部的 mesh/gossip/crypto 類別不列入公開契約，可能改。

## 接真實後端

### 用內建 Firestore（最快上線）

省略三個後端參數，`initialize()` 會載入預設 Firestore/IndexedDB。需要你的環境已初始化 Firebase。

```ts
import { createFirestoreChatClient } from 'nerilo/firestore';

const client = await createFirestoreChatClient({ roomId: 'r1', userId: 'alice' });
await client.connect();
```

### 換成你自己的後端

實作 `SignalingTransport`（把 publish/subscribe 換成你的 WebSocket 收送即可，形狀照 `InMemorySignalingTransport`），選擇性再換 `IRoomDirectory` 與 `IChatStorage`，注入 `createChatClient`。API 完全不變。

```ts
import { createChatClient } from 'nerilo/firestore';
import type { SignalingTransport } from 'nerilo';

class WsSignaling implements SignalingTransport {
  // subscribe / send / cleanupOlderThan / cleanupOwn
}

const client = await createChatClient({
  roomId: 'r1',
  userId: 'alice',
  signaling: (roomId, channelLabel) => new WsSignaling(/* ... */),
});
```

## 版本與相容承諾

### 什麼算「公開表面」

只有這兩個進入點匯出的東西：

- `nerilo` — 純契約（門面、注入介面、純邏輯 reducer、公開資料型別）
- `nerilo/firestore` — turnkey Firestore 工廠

其餘一律是內部實作，即使你有辦法用深層路徑 import 到（`nerilo/dist/...` 之類），
它們隨時會變、不列入任何相容保證。公開表面由 `tests/unit/sdkSurface.spec.ts` 鎖住，
清單有任何增減都必須顯性通過該測試。

### 現在是 0.9.0，這代表什麼

依語意化版號，`0.x` 期間 minor 版號就可以帶破壞性變更，Nerilo 也不例外。
不含糊其辭，直接把規則寫死：

| 版號變動 | 你會遇到什麼 |
|---|---|
| patch（0.9.0 → 0.9.1） | 永不破壞。修 bug、補文件、內部重構。 |
| minor（0.9.x → 0.10.0） | **可能破壞**。破壞項逐條列在 release notes，並附遷移寫法。 |
| major（→ 1.0.0） | 表面凍結的起點，見下。 |

棄用流程：要移除的東西先在一個 minor 標記 deprecated（型別上標註 + release notes 點名），
最快下一個 minor 才真的移除。不做無預警拔除。

### 1.0 承諾什麼，以及何時發

1.0 之後，公開表面的破壞性變更只在主版號跳動時發生。

1.0 的發佈條件是**外部證據**，不是內部覺得夠好了：

- 至少一個非本專案的嵌入者，在真實場景（非 demo）跑過完整流程。
- 該嵌入者對注入四件套（signaling / directory / auth-uid / storage）給過一輪回饋並收斂。

在那之前維持 0.x，是為了讓表面還有機會依真實用法修正。把還沒被人用過的 API 貼上 1.0 標籤，
對採用者不是保障而是誤導。
