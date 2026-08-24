# Spec 023：讓嵌入者開低延遲原始通道（openRawChannel）

- 軌別：feature
- 狀態：planned
- 建立：2026-08-24／最後更新：2026-08-24
- 關聯：ADR-0025（可嵌入 SDK）、block-brawl `docs/nerilo-integration.md` 方案 A（`規劃/點子停車場.md:12`）、Spec 005（p2p2p signaling）、Spec 013（SDK 契約）

## 1. 要做什麼、為什麼（specify）

第一個非聊天嵌入者（block-brawl，2026-07-25）的實測結論：遊戲的高頻輸入流量（每格 100-150 bytes、每秒數十則、可容忍丟包但不容忍延遲）完全不適合走 Nerilo 的訊息層——訊息層有恰好一次保證、E2EE 封裝、每人每秒 10 則的速率設計，全是為「聊天級可靠訊息」做的取捨。結果該遊戲只能拿 Nerilo 換 SDP/ICE，然後**自建** RTCDataChannel（unordered、不重傳）跑遊戲資料。

這代表「遊戲傳輸基礎」的定位目前只有 signaling 一半成立。要補的是：讓嵌入者在 Nerilo 已建立的 peer 連線上，**開一條自訂語義的原始通道**（可指定 ordered / maxRetransmits 等 DataChannel 參數），遊戲資料直接走這條，不經訊息層的可靠性與加密管線。沒有它，每個遊戲嵌入者都要重複 block-brawl 的自建工程（連線管理、重連、與 signaling 的生命週期綁定）。

使用者 2026-08-24 拍板產品方向：Nerilo 除了聊天，也要是遊戲的傳輸基礎。本 spec 是該方向的第一塊承重牆。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**可嵌入**（真實嵌入者的實測缺口，有 block-brawl 案例背書）；補助競爭力（「層而非 App」敘事的直接證據：同一層之上長出聊天與遊戲兩種應用）。
- 四條不變量影響：恰好一次〈**有→必須明示不適用**：原始通道刻意不提供恰好一次，嵌入者自負；不得讓嵌入者誤以為有〉；E2EE〈**有→待釐清 Q1**：原始通道要不要提供加密，或明示不加密〉；帳本正當性〈無影響〉；身分授權〈有→通道建立必須沿用既有 peer 身分驗證，不得成為繞過房間成員資格的旁門〉。

## 2. 邊界（明確不做）

- 不做可靠傳輸、順序保證、重送、壅塞控制（DataChannel 原生語義直通，參數由嵌入者指定）。
- 不做 lockstep／rollback 等 netcode 演算法（那是應用層的事，block-brawl 已證明可以自建）。
- 不動訊息層的任何行為（速率、E2EE、恰好一次照舊）。
- 不做超出 WebRTC DataChannel 能力的東西（頻寬保證、QoS 分級）。
- 不在本 spec 處理房間目錄（Spec 014）與連線狀態 API（Spec 024），三者獨立交付。

## 3. 待釐清（clarify，2026-08-24 拍板，決議內嵌於各題）

- [x] **Q1 加密語義**：使用者拍板 **(c) 強制走房間金鑰**。
  〔誠實記錄〕提案者原建議 (a) 明示不加密（延遲最低、實作最快）；使用者選 (c)，
  與憲法第 2 條「隱私不可妥協」一致。承接的代價：①金鑰未就緒時封包**丟棄**而非排隊
  （低延遲語義下排隊反而錯，丟棄需計數並 fail-visible）；②每包多一次 AES-GCM
  （SubtleCrypto 對 150 bytes 級封包為次毫秒級，驗收 V3 以實測數字把關而非假設）；
  ③金鑰輪替窗內兩代並存，收端沿用既有「保留前代金鑰」機制，不得停流。
- [x] **Q2 API 位置**：使用者拍板 **(b) 獨立輕量入口 `nerilo/transport`**。
  〔誠實記錄〕提案者原建議先做門面方法。降險發現（2026-08-24 查證）：`MeshGossipManager`
  本可獨立建構（roomId, uid, signalingFactory, directory），聊天服務只是外層包裝
  （`MeshChatService.ts:41`），故獨立入口不需抽取手術，工程量比預估低。
- [x] **Q3 對象模型**（技術判斷，由提案者決定並記錄）：只做 **1 對 1 通道**。
  廣播是應用層一個迴圈的事，收進契約會把「哪些 peer、失敗怎麼辦」的政策鎖死。
- [x] **Q4 與 mesh 的關係**（技術判斷）：**複用 mesh 既有 RTCPeerConnection**，
  在其上開新 DataChannel（label 加 `raw:` 前綴避免與 gossip 通道相撞）。Q1 拍板
  房間金鑰後這近乎必然：金鑰分發本來就活在 mesh 上，獨立連線等於要重做一次 keyx。
  生命週期耦合（mesh 重連通道跟著斷）以 `onClose` 事件誠實透出，重開由嵌入者決定。

## 4. 技術計畫（plan）

### 4.1 新入口 `nerilo/transport`

```
createTransportClient(config: {
  roomId, userId,
  signaling?: SignalingFactory,   // 省略＝Firestore（延遲載入，比照 nerilo/firestore）
  directory?: IRoomDirectory,
}): Promise<NeriloTransportClient>

NeriloTransportClient {
  connect(): Promise<void>
  peers(): string[]                          // 目前可達的 mesh 鄰居
  onPeerChange(cb): () => void
  openRawChannel(peerId, label, init?: { ordered?, maxRetransmits?, maxPacketLifeTime? }): Promise<RawChannel>
  dispose(): Promise<void>
}

RawChannel {
  send(data: Uint8Array | string): void      // 同步、可丟（金鑰未就緒或通道未開＝丟棄+計數）
  onMessage(cb: (data, from) => void): () => void
  onClose(cb): () => void
  dropped(): number                          // fail-visible：被丟棄的送出計數
  close(): void
}
```

內部組成：直接建 `MeshGossipManager`（mesh 成形＋keyx 照舊），**不建 MeshChatService**
（訊息層的恰好一次/去重/歷史全部不進來）。通道資料以現行房間金鑰 AES-GCM 密封，
信封帶 epoch 供收端選鑰；不進 gossip、不去重、不補送，DataChannel 原生語義直通。

### 4.2 取捨（為何這樣不那樣）

- 丟棄而非排隊：排隊會把「舊輸入」在金鑰就緒後灌給遊戲，對 lockstep 是毒藥；丟棄＋計數
  讓嵌入者自己決定（遊戲本來就有 input 冗餘視窗）。
- 不重用訊息層信封格式：raw 通道的每 byte 都是延遲，只帶 epoch + IV + 密文的最小頭。
  此為新線上格式 → 完成後回填至協議文件（版本欄位從 v1 起）。
- `nerilo/transport` 與 `nerilo/firestore` 同構：主入口保持純契約，重型工廠進 subpath。

## 5. 任務分解（tasks）

- [ ] T1：`RawChannelCrypto` 純邏輯（房金鑰密封/開封、epoch 選鑰、丟棄計數），單元先行。
- [ ] T2 ⚠：`P2PManager` 支援在既有連線上開具名 DataChannel（`raw:` 前綴、init 參數透傳）。
      動運作中路徑，先走 harden-tests 釘現況。
- [ ] T3：`NeriloTransportClient` 組裝（MeshGossipManager 直建＋keyx 就緒訊號接線）。
- [ ] T4：`src/sdk/transport.ts` 出口 + `package.json` exports 加 `./transport` +
      build:sdk 三入口 + `qa:sdk-isolation` 涵蓋新入口。
- [ ] T5：契約測試（InMemory signaling 雙 client 收發、金鑰未就緒丟棄計數、輪替不停流）。
- [ ] T6：真瀏覽器 E2E：兩分頁經 transport 入口互發 60Hz 級封包，量測 p50/p95 延遲。
- [ ] T7：SDK-QUICKSTART 加「遊戲傳輸」一節（含 Q1 的加密語義與丟棄語義，誠實揭露）。
- [ ] T8：block-brawl 換裝（V1 執行面）。

## 6. 驗收（黃金判準）

- [ ] V1 外部嵌入者實證：block-brawl 的自建 DataChannel 換成本 API，遊戲邏輯零改動，
      lockstep 對戰通過既有的世界雜湊一致驗證。
- [ ] V2 E2EE 不變量：抓包層面驗證通道 payload 為密文（測試以 hook 斷言無明文出站）；
      金鑰未就緒時零明文洩出（丟棄計數 > 0 且線上零封包）。
- [ ] V3 延遲預算：60Hz 封包在本機雙分頁 p95 額外延遲（相對裸 DataChannel 基線）< 2ms。
      數字不達標回到 Q1 重議，不默默放行。
- [ ] V4 訊息層零回歸：聊天全套既有測試不動搖（transport 入口不碰訊息路徑的證據）。
- [ ] V5 表面受控：`sdkSurface` 納入新出口；`prune-sdk-types --max=30` 不爆。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做
- [x] 第 5 節任務完整實現第 4 節，無遺漏
- [x] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
- [x] 未違反憲法任何一條
