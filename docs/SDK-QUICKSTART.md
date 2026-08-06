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

## 只要 signaling，不要整個聊天客戶端

> **先確認你符合前提，否則現在還用不了。** 這個出口讀寫的是
> `p2pRooms/{roomId}/signals`，而該路徑的 rules 要求：
>
> 1. **房間必須已存在**，且你在它的 `participants` 裡；
> 2. **建立房間的帳號必須是非匿名的**（`sign_in_provider != "anonymous"`）。
>
> 換句話說，目前只有「已經用 Nerilo 房間模型」的應用能用它。純匿名的使用情境
> （例如遊戲大廳，玩家不註冊就想開房）**還不行**，缺一個輕量的房間目錄／建房契約，
> 那是 Spec 014，尚未實作。2026-07-26 以第一個外部嵌入者實測確認，記錄於
> `specs/015-expose-firestore-signaling/spec.md` 的 T6。
>
> 已驗證的部分：出口本身在真實 rules 下可用（emulator，`tests/integration/sdk-signaling.spec.ts`）。
> 未驗證：跨實體裝置、以及非 Nerilo-app 的嵌入情境。

前提符合的話，自帶 Firebase 專案即可直接用 Nerilo 那份跑在 production 的實作：

```ts
import { createFirestoreSignaling } from 'nerilo/firestore';

const signaling = createFirestoreSignaling();
const transport = signaling(roomId, 'my-channel');

// 訂閱：cutoffMs 之後寫入的 signal（回傳取消訂閱）
const off = transport.subscribe(Date.now(), (raw) => {
  if (raw.from === myUid) return; // 契約規定自己送的也會收到，收端自行過濾
  if (raw.type === 'sdp') { /* raw.payload */ }
});

// 送出：from / to / type / payload / channelLabel / createdAt 由你組
await transport.send({
  from: myUid, to: peerUid, type: 'sdp',
  payload: { desc }, channelLabel: 'my-channel', createdAt: Date.now(),
});
```

`createdAt` 傳毫秒數字即可，內部會轉 Firestore `Timestamp`；`expiresAt`（5 分鐘）由
transport 自動補上，你不用管。工廠是同步的，Firestore 到第一次真正用到才載入。

### 你必須自備的 rules

signaling 的完整性邊界是**你的** rules，不是密碼學（見下方誠實邊界）。最小可用版本：

```
match /p2pRooms/{roomId}/signals/{signalId} {
  // 只有房間參與者能讀；否則任何登入者都能爬全站 SDP／ICE 建使用者圖譜
  allow read: if request.auth != null && (
    request.auth.uid in get(/databases/$(database)/documents/p2pRooms/$(roomId)).data.participants ||
    request.auth.uid == get(/databases/$(database)/documents/p2pRooms/$(roomId)).data.ownerUid
  );
  allow create: if request.auth != null
    && request.resource.data.from == request.auth.uid          // 不能冒名
    && request.resource.data.type in ['offer', 'answer', 'ice']
    && request.resource.size() < 10 * 1024
    && request.resource.data.expiresAt is timestamp
    && request.resource.data.expiresAt > request.time
    && request.resource.data.expiresAt <= request.time + duration.value(10, 'm')
    && (request.resource.data.createdAt is number || request.resource.data.createdAt is timestamp);
  allow update: if false;                                      // append-only
  allow delete: if request.auth != null && resource.data.from == request.auth.uid;
}
```

### 所需索引

`cleanupOwn()` 會用到，加進 `firestore.indexes.json`：

```json
{
  "collectionGroup": "signals",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "from", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

建議一併設 `expiresAt` 的原生 TTL policy，讓過期 signal 自動清掉。

### 誠實邊界（請先讀完再決定要不要用）

- 這條通道傳的是 **SDP／ICE，不是訊息內容**；它本身不提供端到端加密。
- 內容對**你的** Firestore 後端可見。要保護訊息內容請用 `NeriloClient`（E2EE 在那一層）。
- **SDP 尚未簽章**（GOAL-ANALYSIS GS2 未做，風險登記 R9）。signaling 的完整性靠你的
  Firebase auth 與上面那份 rules，不是密碼學。有能力偽造已認證寫入的攻擊者可以做 MITM。
- 詳細威脅模型見 [THREAT_MODEL.md](THREAT_MODEL.md)。

### warm 中繼（進階，且有前提）

如果你的應用**已經在跑 Nerilo mesh**，新成員的 signaling 可以走既有鄰居的加密轉送、
完全不落伺服器（Spec 005 的「第三人零 Firestore 寫入」）：

```ts
import { createWarmColdSignaling } from 'nerilo/firestore';

const signaling = createWarmColdSignaling({
  warm: { nodeId, relayBus, hasWarmPath, identity: { ecdhPrivateKey, sign }, peerKeys },
});
```

**沒有 mesh 就不要用這個。** warm 不是可獨立安裝的傳輸，而是架在你**已有的鄰居連線**
上的中繼：`relayBus` 得把信封送進那些連線，`hasWarmPath()` 回報現在有沒有連線可用。
沒有底材時 `hasWarmPath()` 恆 false，整條路徑等同純 cold，這種情況直接用
`createFirestoreSignaling()` 更清楚。

省略 `warm` 時，`createWarmColdSignaling` **直接回傳 cold 工廠本身**，不包任何看起來
像 warm 的殼。這個等價有測試釘住（`tests/unit/WarmColdSignalingExport.spec.ts`），
不是文件上的但書。

## 版本與相容承諾

### 什麼算「公開表面」

只有這兩個進入點匯出的東西：

- `nerilo`：純契約（門面、注入介面、純邏輯 reducer、公開資料型別）
- `nerilo/firestore`：turnkey Firestore 工廠

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
