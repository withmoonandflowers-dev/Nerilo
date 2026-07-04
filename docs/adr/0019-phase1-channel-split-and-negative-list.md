# ADR-0019：Phase 1 通道分流、狀態幀格式與負面清單

- 狀態：Accepted（2026-07-04）
- 日期：2026-07-04
- 相關：ADR-0004（fallback 一律密文）、ADR-0015（遊戲為第二應用）、ADR-0018（schema-first wire 格式）

## Context

外部審視建議（經 goal 分析採納，含兩處修正）：Phase 1 以 2 人直連把即時遊戲
資料流跑起來。核心痛點：單一 reliable DataChannel 上，回合開場素材（PNG）會因
SCTP 隊頭阻塞卡住 60Hz 狀態流。盤點後三項基礎已存在——MultiChannelBus（dormant，
三通道骨架+watermark 背壓）、HelloNegotiator（HELLO/HELLO_ACK 已接線）、
ADR-0018 binary codec——本 ADR 是「啟用+改造」而非新做。

## Decision

### 1. 三條 DataChannel 分流

| 通道 | 參數 | 載荷 |
|---|---|---|
| control | ordered+reliable | 協議控制、名冊、lockstep 輸入等不可丟訊息 |
| state | **ordered:false, maxRetransmits:0** | 60Hz 狀態幀——丟幀不重傳，下一幀天然覆蓋 |
| bulk | ordered+reliable，高水位 | 素材/檔案，不與 control 搶隊頭 |

`ChannelKind` 加 `'state'`；建立參數收斂於 `CHANNEL_INIT`（types，單一真相來源）。
state 通道 watermark 64KB——水位滿代表產幀快過網路，正確行為是丟幀而非排隊。

### 2. 混合資料格式（雙軌，刻意不統一）

- **控制訊息**照走 P2PChannelBus envelope（完整驗證），不動。
- **狀態幀不過 P2PChannelBus**：60Hz 過 JSON envelope 驗證是浪費；幀走 state
  通道 + ADR-0018 binary。幀格式 `[seq varint][rosterVer varint][payload]`
  （`defineStateFrame`），收端 `FrameGate` 丟棄 stale 幀。
- **名冊走 reliable、幀帶 rosterVer**：亂序通道上幀可能引用還不認識的實體；
  收端名冊版本落後於幀時，緩到名冊追上再套用。

此雙軌是設計決策，非債務——請勿日後「統一」回單軌。

### 3. HELLO 嚴格版本（硬擋，不降級）

HelloPayload 加 `strictProtocols`（如 `{game: 2}`）：雙方都宣告同一協議時版本
**必須相等**，不等即列入 `strictMismatches`——上層停用該 feature 並提示
「請雙方重新整理」。與一般 `protocolVersion` 的 min() 降級語義並存：
聊天可以降級相容，狀態幀格式錯位沒有降級可言（錯位即 desync）。
這一步保護之後所有協定改動，為遷移路徑第一步。

### 4. 斷線處理：ICE restart 一次重試

connectionState `failed` 時（換網路/NAT rebind 常見可救）：發起方
`restartIce()` + 重新 offer 走既有 signaling；應答方等新 offer。15 秒未恢復
才定案 failed。一次為限，避免無限重試遮蔽真實故障。UI 據 state 呈現
重連中/失敗（狀態列常駐，接線屬前端層）。

### 5. 負面清單（Phase 1 明確不搬）

| 不搬 | 理由 |
|---|---|
| mesh / gossip | 2 人直連用不到 |
| 因果排序（HLC/CausalBuffer） | lockstep tick 即全序 |
| StoreAndForward | 掉線即斷，遊戲沒有離線補送語義 |
| 應用層 E2EE（狀態幀） | 2 人**直連**時 DTLS 已加密線路 |

**E2EE 免除的強制前提**：狀態幀**禁用 Firestore fallback（P2P-only）**。
未加密幀經伺服器中繼即違反 ADR-0004「fallback 一律密文」鐵律。
control 通道上的聊天等訊息維持既有 E2EE 不變。

### 6. Lobby 修正：匿名 Auth 延後

建議原文的「匿名 Auth 即可」與現行 rules 衝突（create 要求非匿名，
ADR-0005 配額防濫用建立在真實身分上）。Phase 1 維持非匿名；
匿名需先回答「匿名帳號配額怎麼算」，列 Phase 2 議題。
房號制本就是現有主路徑；手動邀請碼收進進階摺疊、ICE restart 狀態列
屬前端層，隨 Vue 重寫（ADR-0017）接線。

## Consequences

- **好處**：素材不再卡狀態流；狀態幀個位數~十幾 bytes（ADR-0018 codec）；
  協定改動有 HELLO 硬擋保護；範圍蔓延有負面清單擋。
- **成本／風險**：state 通道尚未接進 P2PManager 的通道建立流程（現行單通道
  `ordered:true`）——接線排 game demo（M4）；FrameGate 只解決 stale，
  不解決丟幀後的視覺跳變（插值/預測屬遊戲層，不屬傳輸層）。
- **已交付**（本 ADR 同批）：`ChannelKind.state` + `CHANNEL_INIT`、
  MultiChannelBus watermark、`defineStateFrame`/`createFrameGate`、
  HelloNegotiator `strictProtocols`、P2PConnectionManager ICE restart，含測試。
