# ADR-0031：休眠模組處置與死重圍籬

日期：2026-07-16。狀態：已決。方法：架構收斂稽核 `docs/audit/architecture-convergence-2026-07.md` §3。

## 背景

稽核實測：`src/core` 約三分之一是「測過但沒接進產品流」的死重（產品流/SDK 零引用），把地基埋住，讓消費者與 AI agent 看不清「哪些是我該用的」。稽核第③步要求對每塊給明確動詞、寫進 ADR，不再模稜兩可地「先留著」。ADR-0007 已有凍結先例，本 ADR 逐塊定案並加**機器強制的圍籬**（適應度函數），防止未來悄悄重新接線後又爛回去。

## 逐塊處置（實測依據）

「產品流引用」= `src/features|pages|sdk|services` + `web-vue/app` 的非測試引用。

| 模組 | 行數 | 產品流引用 | 全 src 非測試引用 | 處置 | 解凍觸發條件 |
|---|---|---|---|---|---|
| `core/community` | 2272 | 0 | 0 | **PARK** | 有真實使用者且需多人社群治理（投票/角色權限/聲譽）時 |
| `core/game`（ECS 引擎） | 3985 | 0 | 0 | **PARK** | 要做 3+ 人 mesh 即時遊戲（里程碑 2+）；現有遊戲 UI 只用 `features/game` 薄層，不碰 ECS |
| `core/transport`（DHT/StoreAndForward） | 999 | 0 | 0 | **PARK** | 超大規模（>20 人 super-node）或需 DHT 儲存時 |
| `core/chain`（append-only log merge） | 936 | 0 | 0 | **PARK（傾向未來 DELETE）** | 幾乎不會——功能與 mesh 複寫日誌（ADR-0023）重疊；除非需獨立於 mesh 的日誌合併 |
| `core/ledger`（SharedLedgerEngine/ForkResolver） | 401 | 0 | 0 | **PARK** | 需多方共享帳本合併時（與 incentive/CreditLedger 點數帳本不同，那個已用） |
| `core/protocol`（AckManager 殘留） | 91 | 0 | 0 | **PARK（傾向 DELETE）** | 疑似殘留；下輪清理可直接刪 |
| `core/metrics` | 814 | 1（ConnectionStats） | — | **KEEP** | ConnectionStats 已接 FirestoreChatFallback；遙測子部分（RemoteTelemetry/MetricsExporter）休眠但不圍 |
| `core/crypto` TreeKEM + GroupKeyManager | ~1100 | 推論待查 | GroupKeyManager 被 mesh 用 | **不動（待專門分析）** | GroupKeyManager 被 RoomKeyDistribution/RecordCrypto（活的 mesh）引用，TreeKEM 經它牽連；不草率碰 crypto，另立分析 |

PARK 合計約 8684 行。**PARK ≠ 刪**：程式與測試保留（可稽核、可解凍），但用圍籬凍結，不許新接線。

## 死重圍籬（適應度函數，機器強制）

在 `.eslintrc.cjs` 加規則：**產品流與 KEPT core 不得 import 上述 6 個 PARK 模組**（模組自身與其測試除外）。目前引用數為 0，故加規則不破壞現況；它防的是「未來不小心又接上去」。要解凍某模組＝從圍籬名單移除該路徑 + 更新本 ADR 的處置，是有意識的決定，不是手滑。

## 取捨

- PARK 而非現在全刪：死重有測試背書，刪除有風險且部分模組（game/community）使用者可能想復活；PARK + 圍籬已達成「明確處置、不再模稜兩可」，風險最低。
- 不碰 crypto：TreeKEM/GroupKeyManager 與活的 mesh crypto 糾纏，是全系統最高風險模組，草率圍/刪不值得，另立專門分析。
- web-vue 側圍籬：web-vue 有獨立 eslint（Nuxt），本 ADR 的圍籬先覆蓋 `src/` 側；web-vue 對這些模組現況也是 0 引用，其圍籬列為 follow-up。

## 後果

消費者/agent 看到的 `src/core` 從「一坨分不清死活的東西」變成「KEEP-CORE + 明確凍結的 PARK」。稽核 §3 收斂決策落地；§6 適應度函數再添一條。
