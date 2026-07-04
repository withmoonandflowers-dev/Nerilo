# Nerilo 串接規格（Integration Spec）

> 給想在 Nerilo 上傳遞資料的開發者。Nerilo 是**傳輸中立的 P2P 資料傳遞基礎架構**——
> 你送 bytes，它負責安全、直連、便宜地送到對端。上面蓋什麼（聊天、遊戲、協作…）是你的事。
>
> 版本：對齊 ADR-0004/0018/0019/0021。成熟度標籤見每節；**請勿串接標「未接線」的功能**。

---

## 0. 心智模型（30 秒）

- **房間（Room）= 資料流容器**（不是聊天室）。一個房間內的 peers 互相直連。
- **Namespace（ns）= 你的頻道**。你自己取一個字串（如 `'myapp'`），送/收都用它，
  跟別的應用（`chat`/`game`/`presence`）在同一條連線上共存、互不干擾。
- **兩種管道**：可靠（控制/訊息）走 envelope；不可靠（高頻狀態）走 binary 幀。
- **內容自動 E2EE**：伺服器與中繼看不到你的 payload。

---

## 1. 你不需要處理的事（Nerilo 已包辦）

| | |
|---|---|
| 找到對端、NAT 穿透 | signaling + STUN/TURN 自動 |
| 內容加密 | AES-256-GCM sender key，透明 |
| P2P 連不上時的備援 | Firestore 密文中繼自動接手 |
| 斷線重連 | ICE restart 一次自動重試 |
| 版本不合偵測 | HELLO capability negotiation |

## 2. 你要自己處理的事（Nerilo 不提供）

- **應用邏輯**（遊戲規則、訊息語意）——你的事。
- **伺服器權威 / 反作弊**——P2P 無裁判，state-hash 抽驗只擋 casual（見 §9）。
- **點數兌換**——Nerilo 只「產生」點數（§8），換成什麼由你決定。
- **UI**——純傳輸層，無畫面。

---

## 3. 快速開始（可靠訊息）　`成熟度：穩定`

取得連線的 channel bus（經 P2PManager／星型拓撲），然後 subscribe + send：

```ts
import type { P2PChannelBus } from '@/core/p2p/P2PChannelBus';
import type { P2PEnvelope } from '@/types';

const bus: P2PChannelBus = p2pManager.getChannelBus()!; // 連線就緒後非 null

// 收：訂閱你的 namespace
const unsubscribe = bus.subscribe('myapp', (env: P2PEnvelope) => {
  if (env.type === 'MOVE') handleMove(env.payload);
});

// 送：組一個 envelope
await bus.send({
  v: 1,
  ns: 'myapp',
  type: 'MOVE',
  id: crypto.randomUUID(),
  ts: Date.now(),
  from: myPeerId,
  payload: { x: 3, y: 5 },
});

// 清理
unsubscribe();
```

**分派規則**：bus 依 `envelope.ns` 找對應 handler。核心**不認識** namespace 清單——
你自帶 `ns` 就掛得上（開閉原則）。`subscribe('*', ...)` 收所有 namespace。

---

## 4. Envelope 契約　`成熟度：穩定`

`bus.send()` / handler 收到的物件（型別 `P2PEnvelope`）：

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `v` | number | ✅ | 協議版本，目前 `1` |
| `ns` | string | ✅ | 你的 namespace（非空字串） |
| `type` | string | ✅ | 你自定的訊息型別 |
| `id` | string | ✅ | 唯一 ID，去重用（建議 UUID） |
| `ts` | number | ✅ | 送出時間戳（`Date.now()`） |
| `from` | string | ✅ | 來源 peer ID |
| `to` | string | — | 定向對象（省略=廣播給連線對端） |
| `replyTo` | string | — | 回覆某則 `id` |
| `payload` | unknown | ✅（可為任意值，但需存在） | 你的資料；自動 E2EE |
| `meta` | object | — | 額外 metadata |

**驗證**：收端嚴格檢查型別，`ns`/`type` 不得為保留字（`__proto__`/`constructor`/`prototype`）。
畸形 envelope 被丟棄並發 `system`/`ERROR`（見 §10）。

**大小上限**：單則 inbound < **256 KB**，超過丟棄。大資料請分塊或走 bulk（未來）。

---

## 5. 高頻狀態流（不可靠二進位）　`成熟度：Beta（傳輸層已接，2 人星型）`

60Hz 狀態同步等「丟一幀沒關係、下一幀覆蓋」的流量，**不要**走 envelope（JSON 驗證是浪費），
改走 state channel（`ordered:false, maxRetransmits:0`）：

```ts
import { defineComponent, f32 } from '@/core/game/sdk/schema';
import { defineStateFrame, createFrameGate } from '@/core/game/sdk/StateFrameCodec';

const sc = p2pManager.getStateChannel();      // null 表示對端不支援
const Pos = defineComponent('pos', { x: f32, y: f32 });
const Frame = defineStateFrame(Pos);
const gate = createFrameGate();

// 送（binary，未 open 自動丟棄）
sc?.send(Frame.encode(seq++, rosterVer, { x, y }));

// 收
sc?.onFrame((bytes) => {
  const f = Frame.decode(bytes);
  if (!gate.accept(f.seq)) return;            // stale 幀丟棄（亂序天然）
  render(f.data);
});
```

**注意**：state channel 不做 E2EE 應用層加密（DTLS 已加密線路）；**禁走 Firestore fallback**
（P2P-only，斷線就是斷線）。名冊變更走可靠通道，幀帶 `rosterVer` 對齊（見 StateFrameCodec）。

---

## 6. 緊湊 payload 編碼（選用）　`成熟度：穩定`

payload 想省頻寬（尤其高頻），用 schema-first binary codec（ADR-0018）：

```ts
import { defineInput } from '@/core/game/sdk/InputCodec';
import { q8 } from '@/core/game/sdk/schema';

const Input = defineInput({
  actions: ['up', 'down', 'fire'],            // → bitmask
  axes: { moveX: q8(-1, 1) },                 // → 量化 1 byte
});
const bytes = Input.encode({ peerId, tick, seq, actions: ['up'], axes: { moveX: 0.5 } });
// ~60B JSON → ≤8B。所有 peer 用「同一份 schema」才位元一致（determinism 紅線）。
```

原語：`u8/u16/u32/i8/i16/i32/f32/f64/varint/bool/str/q8`、`defineComponent`。

---

## 7. 連線生命週期與版本協商　`成熟度：穩定`

- **狀態**：`idle → connecting → connected → (disconnected) → failed/closed`。訂閱拓撲/manager 的狀態事件。
- **能力協商**：連線開啟後雙方交換 HELLO，算出 feature 交集。
- **嚴格版本（防 desync）**：宣告 `strictProtocols: { myapp: 2 }`——雙方都宣告同 key 時
  **版本必須相等**，不等會列入 `strictMismatches`，你應停用該功能並提示使用者更新
  （狀態幀格式錯位無法降級相容，錯位即 desync）。

---

## 8. 中繼即價值：點數原語　`成熟度：產生已備／兌換不提供`

Nerilo 讓「在線/中繼貢獻」產生點數，作為激勵層：

```ts
import { creditEconomy } from '@/core/incentive/CreditEconomy';

await creditEconomy.getBalance();                 // 讀餘額
await creditEconomy.trySpend(10, 'myapp:powerup'); // 花點（不足回 false）
creditEconomy.subscribe((b) => updateUI(b.balance));
```

- **產生**：連線在線（自動）+ 中繼他人流量（`recordRelayContribution`，接 §11 後生效）。
- **Nerilo 不做兌換**：換成真實好處由你/玩家決定（避免類金融負擔）。Phase 1 為本機、無真實價值、無 sybil 抵抗——**兌換真實價值前你需自建防刷**。

---

## 9. 安全模型（你該知道的）

- **內容**：envelope payload 端到端加密；伺服器/中繼只見密文 + 時間 metadata。
- **完整性**：`from == auth.uid`（Firestore 層）、envelope 嚴格驗證（P2P 層）。
- **P2P 無伺服器權威**：對端能看到傳給它的完整資料 → **競技級反作弊做不到**；
  適合 casual。需權威請自建伺服器（非本架構）。
- **metadata**：房間成員、時間、密文大小仍可觀察（公開房參與者可讀）。

---

## 10. 錯誤處理

訂閱 `system` namespace 收傳輸層錯誤：

```ts
bus.subscribe('system', (env) => {
  if (env.type === 'ERROR') {
    // env.payload: { type: 'OVERSIZED_MESSAGE' | 'PARSE_ERROR' | 'CHANNEL_ERROR' | 'INVALID_ENVELOPE', ... }
  }
});
```

`system` 為保留 namespace，勿用作你的應用頻道。其他保留：`chat` `game` `presence` `file` `media`。

---

## 11. 成熟度總表（串接前必看）

| 能力 | 成熟度 | 可串接？ |
|---|---|---|
| 可靠訊息（envelope + bus） | 🟢 穩定 | ✅ |
| Envelope 契約 / 嚴格驗證 | 🟢 穩定 | ✅ |
| 緊湊 binary codec | 🟢 穩定 | ✅ |
| E2EE 內容加密 | 🟢 穩定 | ✅ |
| HELLO 版本協商 | 🟢 穩定 | ✅ |
| Firestore fallback（可靠） | 🟢 穩定 | ✅ |
| 點數：產生 + 讀/花 facade | 🟢 穩定 | ✅ |
| 不可靠 state channel（高頻） | 🟡 Beta（2 人星型已接） | ⚠️ 可試，API 可能微調 |
| 社群中繼（省成本/救連線） | 🔴 未接線（ADR-0021 分階段） | ❌ 別依賴 |
| 3+ 人 mesh 的上述保證 | 🟡 部分 | ⚠️ 星型最穩 |

---

## 12. 版本與相容

- envelope `v` 與 HELLO `protocolVersion` 一般 feature 走 `min()` 降級相容；
  你的 `strictProtocols` 走「相等否則停用」。
- 本規格隨 ADR 演進；破壞性變更會升 `v` 並更新成熟度表。
- 問題 / 要串接支援：見專案 issue 範本。
