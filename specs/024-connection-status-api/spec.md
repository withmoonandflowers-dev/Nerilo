# Spec 024：讓嵌入者看得到連線與加密狀態

- 軌別：feature
- 狀態：planned
- 建立：2026-08-24／最後更新：2026-08-24
- 關聯：ADR-0025（可嵌入 SDK）、Spec 013（SDK 契約）、GX3 安全分級原語（`src/core/security/securityLabel.ts`）、2026-08-24 SDK 表面體檢

## 1. 要做什麼、為什麼（specify）

SDK 公開表面目前只有訊息面的事件（訊息、表情、已讀、輸入中）。嵌入者無法回答使用者一定會問的兩個問題：「連上了嗎」「加密就緒了嗎」。Nerilo 自家的兩條 UI 線都有狀態列（連線指示、加密指示），但它們是直接讀 core 內部做到的，這條路對 SDK 消費者不存在。結果是：嵌入者要嘛做不出狀態指示，要嘛只能猜（例如以「收到第一則訊息」代表已連線，錯誤且慢）。

對遊戲場景（2026-08-24 拍板的方向）這更關鍵：配對後要等「連線就緒」才能開局，沒有狀態事件就只能輪詢或加保守延遲，直接傷害體驗。

要補的是：門面與 `IChatEngine` 契約增加連線／加密狀態的查詢與訂閱，語義對齊既有內部狀態（不發明新狀態機），並誠實反映降級（P2P 失敗退 Firestore 備援時要看得出來）。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**可嵌入**（嵌入者做產品必問的能力）；隱私韌性（把「現在走的是 P2P 還是備援、加密就緒與否」誠實透出，符合憲法第 10 條自我揭露）。
- 四條不變量影響：恰好一次〈無影響：唯讀透出〉；E2EE〈無影響：只透出狀態，不動金鑰路徑；且有正面貢獻——嵌入者能在金鑰未就緒時提示使用者，而非誤以為已加密〉；帳本正當性〈無影響〉；身分授權〈無影響〉。

## 2. 邊界（明確不做）

- 不做逐 peer 的細粒度連線診斷（RTT、丟包率、ICE 候選細節），只做房間級聚合狀態。
- 不改內部狀態機，只透出既有事實。
- 不做歷史狀態記錄與遙測（metrics 已有自己的線）。
- 不在本 spec 處理原始通道（Spec 023）的通道級狀態，但 API 形狀要預留不衝突。

## 3. 待釐清（clarify，2026-08-24 拍板）

- [x] **Q1 狀態粒度**（技術判斷，未見反對即採提案）：兩軸——傳輸
      （connecting / p2p / fallback / offline）與加密（pending / ready / degraded）。
      不合成單一狀態：合成會把「P2P 通了但金鑰未就緒」這種真實中間態藏起來。
- [x] **Q2 API 形狀**（技術判斷）：`client.status`（同步快照）＋ `client.onStatus(cb)`
      （變更訂閱，訂閱當下先收一次），對齊既有 watch 語義。
- [x] **Q3 IChatEngine 破壞性**：使用者拍板 **0.x 直接加為必要方法，CHANGELOG 明示**。
      介面保持乾淨，不背 `getStatus?()` 的永久相容包袱。已知的自帶引擎實作者
      僅 block-brawl，且它實作的是 SignalingTransport 而非 IChatEngine，不受影響。

## 4. 技術計畫（plan）

### 4.1 型別與契約

```
TransportState = 'connecting' | 'p2p' | 'fallback' | 'offline'
EncryptionState = 'pending' | 'ready' | 'degraded'
NeriloStatus = { transport: TransportState; encryption: EncryptionState }

IChatEngine 增：
  getStatus(): NeriloStatus
  onStatus(listener: (s: NeriloStatus) => void): () => void

NeriloClient 增：
  get status(): NeriloStatus            // 委派 engine.getStatus()
  onStatus(cb): () => void              // 委派 + 訂閱當下先發一次
```

### 4.2 狀態來源（只透出既有事實，不建新狀態機）

- encryption：由 GX3 安全分級原語（`src/core/security/securityLabel.ts`）與金鑰就緒訊號
  衍生；ready＝現行代金鑰可用；degraded＝出口閘 fail-visible 態。
- transport：由 mesh 連線集合與備援使用事實衍生；p2p＝至少一條 DataChannel open；
  fallback＝訊息實際走 Firestore 備援中；offline＝兩者皆無且 signaling 不可達。
- 事件去抖：同值不重發（比照已讀水位「只前進才送」的既有慣例）。
- InMemory 引擎（範例/測試用）同步實作，契約測試雙跑。

### 4.3 取捨

- 房間級聚合而非逐 peer：逐 peer 是診斷需求（metrics 線），狀態列需求是聚合；
  逐 peer 版留給未來 spec，本 API 形狀不阻擋（NeriloStatus 可加欄位）。
- 版號：`IChatEngine` 破壞性變更 → 0.10.0，CHANGELOG 標「自帶引擎需補兩方法」。

## 5. 任務分解（tasks）

- [ ] T1：型別 + `IChatEngine` 契約增補 + 純衍生函式（單元先行）。
- [ ] T2 ⚠：`MeshChatService` 實作 getStatus/onStatus（唯讀衍生，動運作中檔案，
      先 harden-tests 釘現況）。
- [ ] T3：`NeriloClient` 門面接線 + sdkSurface 測試更新。
- [ ] T4：examples/minimal-chat 加狀態列（V1 執行面）。
- [ ] T5：E2E：斷 P2P 逼退備援，斷言狀態轉 fallback（V2 執行面）。
- [ ] T6：SDK-QUICKSTART 補狀態一節；CHANGELOG 寫破壞性說明。

## 6. 驗收（黃金判準）

- [ ] V1 嵌入者視角：examples/minimal-chat 加狀態列，只用公開 API 做出
      「連線中→已連線（P2P）→加密就緒」的真實轉換顯示。
- [ ] V2 誠實降級：E2E 證明 P2P 失敗退備援時，狀態如實轉為 fallback，而非停在 p2p。
- [ ] V3 契約可替換：InMemory 與 Firestore 引擎跑同一組狀態契約測試，行為一致。
- [ ] V4 表面受控：`sdkSurface` 更新；`prune-sdk-types --max=30` 不爆。
- [ ] V5 既有測試零回歸（唯讀衍生的證據）。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做
- [x] 第 5 節任務完整實現第 4 節，無遺漏
- [x] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
- [x] 未違反憲法任何一條
