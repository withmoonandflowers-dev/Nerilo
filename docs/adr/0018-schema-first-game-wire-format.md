# ADR-0018：schema-first 遊戲 wire 格式

- 狀態：Accepted（2026-07-04）
- 日期：2026-07-04
- 相關：ADR-0009（資料傳遞架構）、ADR-0010（異質傳輸／窄頻二進位）、ADR-0015（遊戲為第二應用）

## Context

ADR-0015 解凍 game/ 時已標記能力邊界：現行 JSON 通道適合回合制與 lockstep，
「即時動作遊戲需要二進位編碼」列為未來需求。盤點現有 wire 格式後，發現真正的問題
不是「對不對」（lockstep 協議設計完整），而是三種本該分離的格式被混為一談：

| 層 | 該有的性質 | 解凍時現況 |
|---|---|---|
| Authoring（開發者宣告資料） | 有型別、有 schema | `Record<ComponentType, ComponentData>`，純字串 key + `unknown` bag |
| Simulation（記憶體 ECS） | 快、可變 | World，尚可 |
| Wire（過 DataChannel 的 bytes） | 緊湊、可驗證、決定性 | 直接把 authoring 的 untyped bag JSON 丟上線 |

代價集中在熱路徑：INPUT 每 tick 發（tickRate × 玩家數），現行 JSON
`{peerId, tick, actions: string[], axes, seq}` 約 50~70 bytes，其中 peerId 字串與
action 字串每 tick 重送最浪費；而 component 無 schema，收到對方 payload 只能 `as` 硬轉，
desync 難以定位欄位。

## Decision

導入 **schema-first**：開發者宣告一次，派生型別 + 緊湊 codec + 驗證。純加法，不改寫
既有 SDK 流程（既有測試不動）。

1. **二進位原語**（`sdk/schema.ts`）：`Writer`/`Reader` 游標式讀寫，固定 little-endian；
   field codec `u8/u16/u32/i8/i16/i32/f32/f64/varint/bool/str/q8`。
2. **`defineComponent(name, schema)`**：欄位順序 = schema 鍵插入序（JS 穩定），
   派生 `encode/decode/validate`，資料型別由 `InferData<S>` 自 schema 反推。
3. **`defineInput`**（`sdk/InputCodec.ts`）：熱路徑壓縮——固定動作集 → bitmask
   （≤8 動作 1 byte、≤16 用 2、≤32 用 4）、類比軸 → q8（每軸 1 byte）、tick/seq → varint、
   **peerId 不上線**（由 DataChannel 來源推斷，decode 時外部帶入）。實測 sample 從
   ~60 bytes JSON 壓到 ≤8 bytes（省 >80%）。

### 決定性紅線（lockstep 命脈）

- 所有 peer 必須用同一份 schema 的同一套 codec，位元一致。已用測試釘住：同輸入 → 同 bytes、
  跨 codec 實例（同 schema）→ 同 bytes。
- q8 量化用 `Math.round`（跨引擎一致），且**只施加於輸入**這類本就有限精度的值，
  不施加於模擬狀態，避免精度漂移。

### 刻意不做

- **不全 binary**：late-join snapshot 不常發、可 gzip，維持 JSON 以利 debug；
  只有 INPUT 熱路徑走 binary。混合策略。
- **不做巢狀 component**：wire 保持扁平、大小可預測。
- **不在 codec 內做 tick delta**：絕對 tick 的 varint 已夠小；差值壓縮屬傳輸層策略，非 codec 職責。
- **snapshot delta 暫緩**：先交付 defineComponent + INPUT bitmask，delta diff 之後再說。

## Consequences

- **好處**：熱路徑頻寬降一個數量級，為 ADR-0010 的即時動作遊戲（unordered/unreliable +
  二進位）鋪路；component 有了 runtime validator，desync 可定位到欄位；宣告即單一真相來源，
  型別與 wire 不再各寫一份會漂移。
- **成本／風險**：schema 成為決定性契約，改欄位順序或量化範圍等同改協議，需配 envelope 版本號
  （`v`）處理跨版。已於 InputCodec 保留「未宣告動作靜默丟棄」的前向相容行為。
- **尚未接線**：本 ADR 只交付 codec 與測試，尚未替換 GameTransportSDK 既有 JSON 送法；
  接線與 snapshot delta 排後續。
