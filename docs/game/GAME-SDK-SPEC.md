# Nerilo 遊戲開發者規格（完整自助版）

> 給要在 Nerilo 上做多人遊戲的開發者。照這份就能自己做，不需要問平台方。
> 每個 API 對齊真實 code 簽名。成熟度誠實標註（§10）——請勿依賴標「未接線」者。
> companion：[ADR-G01](ADR-G01-game-on-nerilo.md)（決策）、[C4](c4-game-on-nerilo.md)（架構）。

---

## 0. 這份是什麼 / 適合誰

Nerilo 是 P2P 傳輸底層：玩家資料直連互傳、端對端加密、不經你的伺服器。
你寫遊戲邏輯，Nerilo 負責把 bytes 安全送到對端。

**兩種使用層級**，依需求選：
- **高階 SDK**（`GameTransportSDK`）：內建 ECS World、固定步長 GameLoop、lockstep
  輸入同步、seed 協商、房主接替、state-hash 驗證。適合結構化遊戲。
- **低階直連**（`P2PChannelBus` + `StateChannel` + codec）：你自管遊戲迴圈與狀態，
  只借傳輸。適合已有引擎、只要「把資料送到對端」。

---

## 1. 能力與硬限制（先自我篩選）

**適合**：回合制、合作、朋友間、2–5 人、同區域、慢~中節奏、休閒。
**不適合**（請用 Photon/Steam 網路）：競技/排名、快動作、6+ 人、跨區、需公平性保證。

| 硬限制 | 數值 / 說明 |
|---|---|
| 無伺服器權威 | 對端可改自己 client；state-hash 只擋 casual desync，**擋不了競技作弊** |
| 人數 | 2 人星型最穩；3–5 人 mesh 可；6+ 未接線 |
| 延遲 | 同區直連快；跨區 200ms+；lockstep 另加 inputDelay（預設 2 tick） |
| 連通率 | NAT 受阻約 8–15% 需 TURN/中繼；少數連不上 |
| 單則訊息 | 可靠通道 < 256 KB；狀態幀走不可靠通道 |
| 成熟度 | SDK 完整且單元測試過，但**未跑過真實遊戲**；你是第一個實戰者 |

---

## 2. 快速開始（最短路徑）

前提：你已用 Nerilo 建立房間並連上對端，拿到 `p2pManager`（見 Nerilo 主 SDK）。

```ts
import { GameTransportSDK, attachGameTransport } from '@/core/game/sdk';

// 1) 建 SDK
const sdk = new GameTransportSDK({ localPeerId: myId, tickRate: 20 });

// 2) 掛上 Nerilo 傳輸（關鍵接線點；回傳卸除函式）
const bus = p2pManager.getChannelBus()!;
const detach = await attachGameTransport(bus, sdk, myId, roomId);

// 3) 建 session
const session = await sdk.createSession({ maxPlayers: 4, gameVersion: '1.0.0' });

// 4) 註冊你的系統、開跑
sdk.registerSystem(myGameSystem);
sdk.start();

// 5) 每幀提交輸入
sdk.submitLocalInput(['jump'], { moveX: 0.5 });

// 收拾
await detach(); await sdk.destroy();
```

低階版（不要 ECS，只要傳輸）：

```ts
const bus = p2pManager.getChannelBus()!;
bus.subscribe('mygame', (env) => applyRemote(env.type, env.payload));
await bus.send({ v:1, ns:'mygame', type:'MOVE', id:crypto.randomUUID(), ts:Date.now(), from:myId, payload:{cell:4} });
```

---

## 3. 高階 API：GameTransportSDK

`成熟度：Beta（完整+單元測試，未實戰）`

**建構**
```ts
new GameTransportSDK(config: GameTransportSDKConfig)
```
`GameTransportSDKConfig`：
| 欄位 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `localPeerId` | string | 必填 | 本機 peer id |
| `tickRate` | number | 20 | 模擬 Hz |
| `maxPlayers` | number | 8 | 上限（實務 ≤5） |
| `inputDelay` | number | 2 | 輸入延遲 tick |
| `maxPredictionAhead` | number | 8 | 超前上限，超過暫停等待 |
| `validationInterval` | number | 20 | 每幾 tick 抽驗 state-hash |
| `persistenceKey` | string | 'game' | IndexedDB 命名空間 |

**Session**
| 方法 | 簽名 | 說明 |
|---|---|---|
| createSession | `(c: GameSessionConfig) => Promise<GameSession>` | 建 session |
| getSession | `() => GameSession \| null` | 取現有 |
| leaveSession | `() => Promise<void>` | 離開 |

`GameSessionConfig`：`{ sessionId?, maxPlayers, gameVersion, displayName?, tickRate? }`

**ECS（世界/實體/系統）**
| 方法 | 簽名 |
|---|---|
| getWorld | `() => World` |
| createEntity | `(tag?: string) => EntityId` |
| destroyEntity | `(id: EntityId) => void` |
| query | `(...types: string[]) => EntityId[]` |
| registerSystem | `(s: System) => void` |
| removeSystem | `(name: string) => void` |

`System` 介面：`{ name, requiredComponents: string[], priority: number, init?(world), update(entities, world, dt), destroy?() }`

**迴圈與輸入**
| 方法 | 簽名 | 說明 |
|---|---|---|
| submitLocalInput | `(actions?: string[], axes?: Record<string,number>) => PlayerInput` | 每幀提交 |
| start / stop | `() => void` | 起停迴圈 |
| isRunning | `() => boolean` | |
| getCurrentTick | `() => number` | |

**確定性亂數**（lockstep 必用，別用 Math.random）
| 方法 | 簽名 |
|---|---|
| initRNG | `(seed: number) => void` |
| random | `() => number` |
| randomInt | `(min, max) => number` |

**存檔 / 事件 / 收拾**
| 方法 | 簽名 | 說明 |
|---|---|---|
| saveState / loadState | `() => Promise<void>` / `() => Promise<boolean>` | IndexedDB |
| getSyncStatus | `() => {...}` | 同步/desync 狀態 |
| on | `(event, handler) => () => void` | 事件訂閱（見下） |
| destroy | `() => Promise<void>` | 釋放 |

**事件（`GameSDKEvent`）**：`session:created|joined|left|destroyed`、`peer:joined|left`、
`host:migrated`、`game:started|paused|resumed|ended`、`sync:rollback|desync|desync-alert`、
`state:saved|loaded`。

---

## 4. 接線：attachGameTransport

`成熟度：穩定（接線已測，2 人星型）`

```ts
attachGameTransport(
  bus: P2PChannelBus,
  sdk: GameTransportSDK,
  selfId: string,
  roomId: string
): Promise<() => Promise<void>>   // 回傳卸除函式
```
把 SDK 的 outbound 設為 `bus`、inbound 訂閱 `'game'` namespace。這是 SDK ↔ Nerilo
傳輸的唯一接線點。呼叫回傳的函式卸除。

---

## 5. Session API：成員 / seed / 房主接替

`成熟度：SDK 完整`

| 方法 | 簽名 | 說明 |
|---|---|---|
| getState | `() => 'lobby'\|'playing'\|'paused'\|'ended'` | |
| isHost / getHostPeerId | `() => boolean` / `() => string` | 房主 |
| getSeed | `() => number \| null` | 協商後的確定性 seed |
| getPeers / getConnectedPeerIds / getPeerCount | | 成員 |
| addPeer / removePeer | `(peerId, displayName?) => boolean` / `(peerId) => void` | |
| electNewHost | `() => string` | 確定性選新房主 |
| handleHostDisconnect | `(hostId) => void` | 房主斷線接替 |
| startGame / pauseGame / resumeGame / endGame | | 遊戲控制 |
| commitSeed / receiveCommitment / receiveReveal | | seed hash-then-reveal 防作弊協商 |
| serialize | `() => SerializedSessionState` | 給晚加入者同步 |
| on / destroy | | |

---

## 6. 低階 API：直連傳輸

**可靠控制通道**　`成熟度：穩定`
```ts
const bus = p2pManager.getChannelBus();      // P2PChannelBus | null
bus.subscribe(ns: string, (env: P2PEnvelope) => void): () => void
bus.send(env: P2PEnvelope): Promise<void>
bus.getReadyState(): RTCDataChannelState
```
`P2PEnvelope`：`{ v:number, ns:string, type:string, id:string, ts:number, from:string, to?:string, replyTo?:string, payload:unknown, meta?:object }`。單則 < 256KB，自動 E2EE。
保留 ns：`system` `chat` `game` `presence` `file` `media`——自己取別的。

**不可靠狀態通道（高頻）**　`成熟度：Beta（2 人星型）`
```ts
const sc = p2pManager.getStateChannel();     // StateChannel | null
sc.send(frame: Uint8Array): boolean          // 未 open 回 false（丟棄）
sc.onFrame((bytes: Uint8Array) => void): () => void
sc.getReadyState(): RTCDataChannelState
```
不做應用層 E2EE（DTLS 已加密）、禁走 Firestore fallback。

**二進位 codec**　`成熟度：穩定`
```ts
import { defineComponent, defineInput, defineStateFrame, createFrameGate,
         u8,u16,u32,i8,i16,i32,f32,f64,varint,bool,str,q8 } from '@/core/game/sdk';

const Pos = defineComponent('pos', { x: f32, y: f32 });          // encode/decode/validate
const Input = defineInput({ actions:['up','fire'], axes:{ mx: q8(-1,1) } });
const Frame = defineStateFrame(Pos);                             // [seq][rosterVer][payload]
const gate = createFrameGate();                                   // 丟 stale 幀
```
所有 peer 必須用**同一份 schema**才位元一致（determinism 紅線）。

---

## 7. 同步模型（三選一，各附完整範例）

| 模型 | 適合 | 通道 |
|---|---|---|
| 事件式 | 回合制（棋/卡牌） | 可靠 |
| Lockstep | RTS/確定性合作 | 可靠 + seed + submitLocalInput |
| 狀態同步 | 即時 casual | 不可靠狀態通道 |

**事件式**
```ts
bus.subscribe('mygame', (e) => { if (e.type==='MOVE') apply(e.payload); });
await bus.send({ v:1, ns:'mygame', type:'MOVE', id:crypto.randomUUID(), ts:Date.now(), from:myId, payload:{cell} });
```

**Lockstep**（高階 SDK）
```ts
sdk.initRNG(session.getSeed()!);          // 雙方同 seed
sdk.registerSystem(mySystem);              // 純確定性（用 sdk.random，不用 Math.random）
sdk.start();
sdk.submitLocalInput(['move'], { mx: 1 }); // 每幀；SDK 同步輸入 + 抽驗 state-hash
```

**狀態同步**
```ts
sc.send(Frame.encode(seq++, rosterVer, { x, y }));
sc.onFrame((b) => { const f = Frame.decode(b); if (gate.accept(f.seq)) render(f.data); });
```

---

## 8. 連線生命週期與錯誤

- 連線狀態由 Nerilo 主 SDK 提供：`idle → connecting → connected → (disconnected) → failed/closed`。
- `bus`/`sc` 在 connected 後才非 null。connected 前 `send` 會排隊或丟棄（狀態通道）。
- **傳輸錯誤**：訂閱 `system` namespace：
```ts
bus.subscribe('system', (e) => { if (e.type==='ERROR') handle(e.payload); });
// payload.type: 'OVERSIZED_MESSAGE'|'PARSE_ERROR'|'CHANNEL_ERROR'|'INVALID_ENVELOPE'
```
- **房主斷線**：SDK 發 `host:migrated` 事件；`session.electNewHost()` 給確定性新房主。
- **desync**：SDK 發 `sync:desync` / `sync:desync-alert`；state-hash 抽驗偵測。

---

## 9. 安全模型（保證 / 不保證）

| 保證 | 不保證 |
|---|---|
| 內容 E2EE，伺服器/中繼看不到 | 伺服器權威（P2P 無裁判） |
| envelope 嚴格型別驗證、防原型污染 | 競技級反作弊（對端可改自己狀態） |
| `from` 一致性（Firestore 層） | 隱藏 metadata（房間成員/時間可觀察） |
| seed hash-then-reveal 防 seed 作弊 | |

即時動作遊戲的公平性請自建伺服器（非本架構）。

---

## 10. 成熟度矩陣（依賴前必看）

| 能力 | 成熟度 | 可依賴 |
|---|---|---|
| 低階可靠通道（event 式） | 🟢 穩定 | ✅ |
| 二進位 codec | 🟢 穩定 | ✅ |
| E2EE / 版本協商 | 🟢 穩定 | ✅ |
| attachGameTransport 接線 | 🟢 穩定（2 人星型） | ✅ |
| GameTransportSDK / GameSession | 🟡 Beta（測過，未實戰） | ⚠️ 可用，回報 bug |
| 不可靠狀態通道 | 🟡 Beta（2 人星型） | ⚠️ API 可能微調 |
| 3–5 人 mesh 的上述保證 | 🟡 部分 | ⚠️ 星型最穩 |
| 6+ 人 / 社群中繼 | 🔴 未接線 | ❌ 別依賴 |

---

## 11. 版本相容

宣告 `strictProtocols: { yourgame: N }`（經 HELLO capability）：雙方版本不等會被擋
並提示更新——遊戲規則/狀態格式一改就升 N，避免新舊 client 對戰 desync。

---

## 12. API 檔案索引

| 主題 | 檔案 |
|---|---|
| 高階 SDK | `src/core/game/sdk/GameTransportSDK.ts` |
| 接線 | `src/core/game/sdk/P2PBusBroadcast.ts`（`attachGameTransport`） |
| Session | `src/core/game/sdk/GameSession.ts` |
| codec | `src/core/game/sdk/schema.ts` · `InputCodec.ts` · `StateFrameCodec.ts` |
| 可靠通道 | `src/core/p2p/P2PChannelBus.ts` |
| 狀態通道 | `src/core/p2p/StateChannel.ts` |
| 型別 | `src/core/game/sdk/types.ts` · `GameMessageTypes.ts` · `src/core/game/types.ts` |
