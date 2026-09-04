# Spec 028：驗實同儕轉達完整路徑

- 軌別：feature
- 狀態：clarifying（階段 A 可執行規格；階段 B、C 待 B0、C0 擴充）
- 建立：2026-09-04／最後更新：2026-09-04
- 關聯：Spec 005、Spec 021、Spec 027、ADR-0023、ADR-0024、ADR-0031、ADR-0032
- 基準：`b8ce49c018661aa0f74c069021f29f7deb98cbac`

## 1. 要做什麼、為什麼（specify）

Nerilo 要讓已建立關係的成員在中央訊息服務不可用時，仍可透過在線成員轉達密文。網路品質較好的個體可以擔任應用層信使，替暫時離線的成員寄存與補送資料。網路不穩時，系統要保留可量測的備援路徑，並依靠已建立的 Nerilo 群體維持服務。沒有這條路徑，斷線期間的資料只能等待端點再次直接相遇，韌性主張也缺少可重跑證據。

本 spec 分三個階段。階段 A 先驗實可信 TURN、應用層信使跳轉，以及現有 release 閘門。階段 B 再處理陌生人經成員介紹與本地會合點加入。階段 C 才依網路品質選擇信使並處理失效切換。A0 採 feature 軌，因為階段 A 驗證同一套 Nerilo 實作內的既有路徑，不新增跨實作線上格式。若 B0 要新增介紹憑證或變更互通格式，B0 必須重新判定是否改走 protocol 軌。

### 1.1 誠實條款

1. 瀏覽器節點不能充當 TURN 伺服器。瀏覽器端的「轉運站」只能做應用層信使跳轉，也就是接收密文後再轉發。每一跳都會增加延遲。網路層 TURN 與應用層信使是兩條不同路徑，測試與報告不得混為同一項能力。
2. 陌生人第一次配對一定要使用本地會合點、雙向 QR，或既有成員介紹三者之一。零伺服器的初次配對不存在。階段 A 的信使 E2E 可以使用既有 Firestore 名冊與 signaling 建立測試前提，但不得據此宣稱已完成無中央服務的冷啟動。
3. Courier 與 relay overlay 目前只接在 Vue 線。接線點為 `web-vue/app/composables/useCourierNode.ts` 與 `web-vue/app/composables/useNodePresence.ts`。React 生產線沒有這組 overlay，階段 A 不得把 Vue 的信使結果寫成兩條 UI 線都具備的能力。
4. `src/core/transport/StoreAndForward.ts` 仍受 ADR-0031 的 PARK 決策約束。階段 A 以已接線的 `src/core/relay/CourierService.ts` 驗證寄存與補收，StoreAndForward 只作靜態比較。若實作需要接線 StoreAndForward，必須先修訂本 spec 與 ADR-0031。

### 1.2 現況錨點

- `src/core/relay/CourierService.ts` 定義 `COURIER_NS`、`CourierMsgType`、`buildRoomStore`、`CourierServer` 與 `CourierClient`。信使收密文、寄存、對帳與補收均已有程式碼。
- `src/core/relay/CourierStore.ts`、`CourierReceipts.ts`、`courierEligibility.ts` 與 `CongestionPricing.ts` 分別承擔寄存、收據、可寄存紀錄篩選與擁塞計價。
- `src/core/relay/RelayDirectory.ts:45` 定義 `IRelayDirectory` 與記憶體實作；`FirestoreRelayDirectory.ts` 是目前 Vue 線使用的站級名冊。
- `src/core/relay/PeerScoring.ts:53` 已有 `PeerScoring`，包含 `recordDelivery`、`recordDeliveryFailure`、`recordFirstArrival`、`recordMeshPresence` 與 `getScore`。階段 C 尚未把它接到實際選路。
- `src/core/relay/RelayConnector.ts` 與 `RelaySignaling.ts` 可讓互不在同一房間的節點建立站級 DataChannel。現有 characterization 是 `tests/e2e-vue/relay-connect.spec.ts`。
- `scripts/smoke-report.mjs:73` 讀取 `S2-forced-turn`。第 113 至 119 行明確要求先看場景失敗點，不得在沒有統計資料時自行歸因為 TURN 壞掉。

### 1.3 憲法檢核

**目標函數加分項**：

- **補助競爭力**：把 TURN 與信使兩條備援路徑變成可重跑、可展示、可交付的數字，補上目前只有程式與敘事的證據缺口。
- **可維運**：每條路徑都有固定指令、原始輸出、失敗歸因規則與不回退基線，後續可判斷是服務、測試或產品回歸。
- **可嵌入**：階段 A 不擴張公開 SDK 表面，只驗證核心 relay 元件的邊界。未來若要公開新入口，須另行檢查 `src/sdk/index.ts` 匯出與相容性。
- **隱私韌性**：信使只寄存與轉發密文，中央訊息服務不可用時仍保留補收路徑。階段 A 的名冊與 signaling 仍可能使用 Firestore，所以本階段不能宣稱完全移除中央相依。

**四條不變量影響**：

- **訊息恰好一次**：有影響。信使補收可能和既有歷史或即時路徑重疊。A2 必須依 Spec 021 直接斷言每個 `messageId` 最終出現一次，並同時抓漏信與重複。
- **E2EE 機密性**：有影響。C 只能看到並原樣保存合法密文紀錄，不得取得房間內容金鑰或明文。A2 必須斷言 C 保存的內容仍為密文，且 A 補收後才由既有金鑰路徑解密。
- **點數帳本正當性**：階段 A 預設無語義變更。`CourierService` 的報價、欠條、收據與 `src/core/relay/CongestionPricing.ts` 不得繞過。若 A2 需要修改計價或測試專用免計價路徑，必須先回到本 spec 說明影響，不得直接動 ledger。
- **身分與授權**：有影響但不得放寬。現有站級 signaling 綁 Firebase uid，信使紀錄仍要通過簽章、`pubKey` 與 `senderId` 綁定及世代閘門。A2 要先查清 `PULL` 的房間資格邊界，再決定能否作為產品級 E2E 證據。

## 2. 邊界（明確不做）

- 不解凍 20 人以上的 super-node。現行產品房間硬上限是 10，真實程式位置為 `src/services/roomCapacity.ts` 的 `ABSOLUTE_MAX_PARTICIPANTS`。
- 不解凍 `src/core/ledger/`。共享 ledger 由後續 D 階段另行立案；本階段也不改現行 Courier IOU 的帳本語義。
- 不解凍 `src/core/relay/onion/`。ADR-0031 將它列為 PARK，且產品流非測試引用為零。
- 不把 `src/core/transport/StoreAndForward.ts` 接回產品流，除非先修訂本 spec 與 ADR-0031。
- 不改提案原稿與 `送件檔/`。
- 不修改或提交 `.env*`、`firebase.*.json`、`.github/workflows`。測試用 TURN 帳密由操作者放在 `.env.local` 或 `herdr-packets-Nerilo/`，不得寫進 repo 追蹤檔案、測試輸出或 log。
- 不部署、不發佈 npm、不註冊雲端 TURN、不付款。
- 不做兩台實體裝置場測。A2 只做 Playwright 隔離 context 模擬，報告必須明寫「真實兩台實體裝置場測未做」。
- 不在階段 A 新增陌生人冷啟動路徑，也不宣稱零伺服器初次配對。這是階段 B 的範圍。
- 不替 React 生產線接上 Courier 或 relay overlay。階段 A 只驗證 Vue 現有接線。
- 不以加長 timeout、增加 retry 或放寬斷言換取綠燈。

## 3. 待釐清（clarify）

- [x] **Q1 原生 coturn 的可達位址與 relay port 範圍，已回答**：coturn 4.17.2 已安裝，執行檔為 `/usr/local/bin/turnserver`。verify 以前景行程只綁 `127.0.0.1`，並加上 `--no-cli` 與 `--allow-loopback-peers`；後一個旗標是本機兩端都位於 loopback 時的必要條件，未加時 coturn 會拒絕 loopback peer。Chromium 以 `iceTransportPolicy: 'relay'` 取得 `127.0.0.1:49164` 的 relay candidate，relay port 位於 `--min-port=49160` 至 `--max-port=49200` 範圍，且沒有 `onicecandidateerror`；後續獨立量測也確認兩端選中的 candidate 都是 relay，連線狀態為 connected。來源為 `runs/T2v_smoke-prod_20260904T093510Z.md` 與 `runs/T2v_smoke-postfix2_20260904T172948Z.md`。測試後關閉行程，不用 `brew services` 長駐；臨時 realm 與帳密只放在 `.env.local` 與 `herdr-packets-Nerilo/`，不得進 repo。
- [ ] **Q2 A1 的本機受測站位址**：`playwright.smoke.config.ts` 不會啟動 web server。A1 預設以載入 `.env.local` TURN 設定的本機 React dev server 為 `SMOKE_BASE_URL`，不得打未含本輪憑證的正式站。實作時須把確定的 host、port 與啟動指令回填。
- [x] **Q3 A2 的兩個 context 拓撲，已回答**：`tests/e2e-vue/_helpers/users.ts:18-19` 的 `setupUser` 每次都呼叫 `browser.newContext()`，沒有 `storageState`；第 12 至 13 行也會用新的隨機 email 註冊新帳號。身分私鑰存在 IndexedDB 的 `nerilo_identity`／`keypairs`，位置為 `src/core/mesh/IdentityManager.ts:4-6,32-64`。房間金鑰須靠同一個 profile 的 ECDH 私鑰重播 `keyx` 才能還原，位置為 `src/core/mesh/MeshGossipManager.ts:218-235` 與 `src/core/mesh/RoomContentKeys.ts:193-235`。既有「離開再回來」測試 `tests/e2e-vue/rejoin.spec.ts:38-55` 與 `tests/e2e-vue/all-offline-revival.spec.ts:60-80` 都保留同一個 context，只回 dashboard 再進房。因此，原訂「A 關閉 context 後以原身分重開」無法沿用既有手法完成；第三個全新 context 也沒有 A 的 identity、ECDH 與 `keyx` 本地狀態，不能假冒原 A。處置是依第 4.3 節改用同一個 context 離開再回來。
- [x] **Q4 A2 的 PULL 授權，已回答**：`CourierServer` 的 `PULL` 分支只有取出 `roomId`、呼叫 `store.serveRoom(roomId)`、回覆 `records`，位置為 `src/core/relay/CourierService.ts:372-376`。這條分支沒有簽章、`pubKey`／`senderId` 綁定、房籍證明或世代閘門。唯一的共通閘門是協議版本與拒絕 `from === selfId`，位置為 `src/core/relay/CourierService.ts:286`。`CourierStore.serveRoom` 只接收 `roomId`，沒有 requester 參數，位置為 `src/core/relay/CourierStore.ts:277-287`。
  - `IDENTIFY` 雖然會檢查 `pubKeyBindsNodeId`，位置為 `src/core/relay/CourierService.ts:360-366`，但 `PULL` 分支不讀 requester。房籍簽章只用於 `TOMBSTONE`，位置為 `src/core/relay/CourierService.ts:222-227,378-383`，未被 `PULL` 引用。`courierEligibility` 的資格檢查位於 deposit／push 端，位置為 `src/core/relay/CourierStore.ts:215-246`，不在 pull 端。
  - 既有單元測試沒有「非房成員 PULL 被拒」案例。`tests/unit/CourierService.spec.ts:73-100` 只有同一個 client deposit 後 pull 的正向路徑，房籍測試只涵蓋 `TOMBSTONE`，位置為第 337 至 379 行。
  - 影響是任何能向該信使傳送 courier namespace 訊息且知道 `roomId` 的節點，都能拉走該房現存的密文紀錄。內容仍需房間金鑰才能解密，但這會洩漏該房是否有紀錄、紀錄量與 `senderId` 集合，也能透過重複 `PULL` 放大信使流量。
  - ADR-0024 記錄寄存端配額與四層刪除機制，並要求墓碑具備房籍簽章，但全文未記錄 `PULL` 授權的取捨。Spec 021 第 23 行的「身分與授權：無影響」談的是 `runCourierBackup` ingest 前的驗簽，不是誰能向信使拉取紀錄。這是未記錄的缺口，不是既有的刻意設計。是否修正及修正方式待操作者裁決。
- [ ] **Q5 A3 五項非 strict-mode 失敗的根因**：T1v 只記錄錯誤形狀，根因均未定位。任何修正前要由無沙盒 verifier 產生同一 SHA 的 trace 與最小重現，再區分時序、選擇器與產品缺陷。

## 4. 技術計畫（plan）

### 4.1 兩條轉達路徑分開驗證

階段 A 不建立一個模糊的「relay」綜合指標。A1 驗證網路層 TURN，受測者是 coturn 與 WebRTC relay-only candidate pair。A2 驗證應用層信使，受測者是 `RelayConnector`、`CourierService`、`CourierStore` 與 Vue 接線。兩份報告分開落檔，延遲數字不得互相替代。

### 4.2 A1 可信 TURN

1. 使用已安裝的 coturn 4.17.2，執行檔為 `/usr/local/bin/turnserver`。verify 在 relay-only smoke 前以前景行程啟動，只綁 `127.0.0.1` 並加上 `--no-cli`、`--allow-loopback-peers`；缺少後一個旗標時，本機 loopback 兩端必定無法互通。測試結束後關閉行程，不用 `brew services` 長駐。臨時 realm 與帳密只放在 `.env.local` 與 `herdr-packets-Nerilo/`，不得進 repo，也不使用需註冊或付款的服務。
2. 本機 React 站由 `.env.local` 讀取 `VITE_TURN_URLS`、`VITE_TURN_USERNAME` 與 `VITE_TURN_CREDENTIAL`。這些值不得出現在 spec、commit、console 摘要或 T2v 報告。
3. 以 `SMOKE_BASE_URL` 指向本機站執行 `npm run smoke:prod`。`tests/smoke/production.smoke.spec.ts` 的 S2 會把 `iceTransportPolicy` 強制設為 `relay`，並斷言選中的本地 candidate 類型為 `relay`。
4. `scripts/smoke-report.mjs` 讀取 `smoke-artifacts/results.json` 與 `stats.jsonl`，產生 `SMOKE-REPORT.md`。若 S2 沒有統計資料，依第 113 至 119 行先看測試是否在註冊、建房或連線前失敗，不直接判定 TURN 壞掉。

### 4.3 A2 信使模擬 E2E

新增 `tests/e2e-vue/peer-relay-complete.spec.ts`，沿用 `playwright.vue.config.ts` 與 Firebase emulator。測試只走 Vue 現有接線，不新增 React 接線。

A2C characterization 已確認既有測試無法在關閉 context 後還原原 A 的身分與房間金鑰。修訂後的劇本讓 A 的 context 全程保持開啟，只以回到 dashboard 模擬離線，沿用 `tests/e2e-vue/rejoin.spec.ts:38-55` 的手法。這不得稱為 close-context restore，報告也不得宣稱驗過「關閉裝置後還原身分」。若日後要保留 close-context 語義，必須先在本 spec 定義 profile／IndexedDB 還原機制與安全邊界。

受測劇本如下：

1. A 與 B 已透過合法路徑建立房籍與內容金鑰。這是測試前提，不列入信使延遲。
2. A 的 context 不關閉，只離開房間回到 dashboard，以同一個 context 模擬離線。
3. B 使用獨立 context。B 與 C 同時在線時，B 無法直接連到 A，只能把合法密文紀錄寄存給 C，完成後關閉 B 的 context。
4. A 使用原本未關閉的 context 再進房，與仍在線的 C 對帳並補收。量測期間 A 與 B 不同時位於房間內，因此沒有 A 到 B 的直連路徑。
5. 每輪記錄 B 到 C 的寄存延遲、C 到 A 的補收延遲、完整轉達延遲、是否送達、是否重複，以及 C 保存的密文是否逐位元組未變。
6. 至少執行 5 輪。測試輸出單行 `PEER_RELAY_METRICS=<json>`，同時以 `testInfo.attach` 附上 JSON。verifier 將原始指令、UTC 起訖、attempts、delivered、successRate、duplicateCount、每跳 p50/p95、同 context 離開再回來的邊界，以及真實裝置未做聲明寫入 `runs/T2v_peer-relay-complete_<UTC>.md`。

測試不得使用 `depositAndPull` 一步完成整段旅程，也不得直接把密文塞進 A 的本地庫。要透過 production 使用的 `runCourierBackup`、`CourierClient` 與 `CourierServer` 路徑。Q4 已確認 `PULL` 未綁定房籍；A2 綠燈只能證明傳輸與補收會運作，不能當成取回路徑已完成授權的證據。操作者裁決階段 A 登記但不修，修法納入階段 B 的 protocol 軌 Spec 029。

### 4.4 A3 已知 release 失敗

基線 `runs/T1v_test-e2e-release_20260904T055849Z.md` 為 27 項中 21 項通過、6 項失敗。後續 `runs/T2v_a3-traces_20260904T082327Z.md` 同樣為 21 項通過、6 項失敗，但失敗成員在不同輪次之間漂移。兩次基準屬同一 SHA 家族，期間 `src/` 與 `tests/` 未變，因此這批失敗判定為 flaky。

trace 已定位共同根因：測試在連線橫幅亮起後、sender key 分發完成前送出訊息。產品依 ADR-0004 與 Spec 012 P4 拒絕明文降級並將該則標為 failed。這是測試缺少 `expectE2EEReady` 等待條件，不是產品送不出訊息。通過組從 sender key 分發完成到送出的餘裕只有 0.47 至 0.90 秒，足以解釋失敗成員漂移。

| 測試 | 錯誤第一行 | A3 處置 |
|---|---|---|
| `tests/e2e/chat-flow.spec.ts` P1.1 | `Error: expect(locator).toHaveClass(expected) failed` | Alice、Bob 第一次送出前都呼叫既有 `expectE2EEReady`，不改 timeout 或斷言 |
| `tests/e2e/chat-flow.spec.ts` P1.3 | `Error: expect(locator).toBeVisible() failed` | Alice、Bob 第一次送出前都呼叫既有 `expectE2EEReady` |
| `tests/e2e/chat-flow.spec.ts` P1.4 | `Error: expect(locator).toBeVisible() failed` | Alice、Bob 第一次送出前都呼叫既有 `expectE2EEReady` |
| `tests/e2e/chat-flow.spec.ts` P1.5 | `Error: locator.click: strict mode violation` | Alice、Bob 第一次送出前都呼叫既有 `expectE2EEReady`；共用 `sendMessage` 以 aria-label `傳送訊息` 精確選取按鈕，避免同時命中「重新傳送」 |
| `tests/e2e/multi-peer.spec.ts` P1.9 | `Error: expect(locator).toBeVisible() failed` | Alice、Bob、Carol 第一次送出前都呼叫既有 `expectE2EEReady` |
| `tests/e2e/mesh-diagnostic.spec.ts` | `Error: expect(locator).toBeVisible() failed` | 保留 DTLS 與連線拓撲等待，三個 page 另加既有 `expectE2EEReady` |
| `tests/e2e/refresh-recovery.spec.ts` P1.10 | `Error: expect(locator).toBeVisible() failed` | Alice、Bob 第一次送出前都呼叫既有 `expectE2EEReady` |
| `tests/e2e/security.spec.ts` P2.5 | `Error: expect(locator).toBeVisible() failed` | 保留備援模式等待，Alice、Bob 第一次送出前另加既有 `expectE2EEReady` |
| `tests/e2e/security.spec.ts` P2.6 | `expect(received).toBeNull()` 收到 `PERMISSION_DENIED: evaluation error at L307:24 for 'update'` | 根因未定位，依協作規則第二節第三輪以 `test.fixme` 隔離；重查完整 trace、join 後 participants／meshIdentities 前置狀態與規則函式執行期錯誤 |

A3 只補正確的金鑰就緒等待與精確選擇器，不調整既有 timeout、不加 retry，也不放寬斷言。P2.6 沒有完整 trace，故不猜根因或修改 `firestore.rules`。本輪新增 `expectE2EEReady` 後，release 分母仍為 27；若之後總數改變，須先依第 6 節 V3 更新本 spec。

### 4.5 風險與外部相依

- **R1 已結案：兩端經 relay 完成連線與同輪訊息往返**：本機 coturn 只綁 `127.0.0.1` 時，啟動命令必須加上 `--allow-loopback-peers`，否則 coturn 預設拒絕 loopback peer，兩端必定無法互通。加上旗標後，獨立量測取得兩端 `local: relay`、`remote: relay`、`connectionState: connected`，RTT 為 1 至 2 毫秒；訊息送達延遲為 137 毫秒，兩端 E2EE 指示器均到達「端到端加密」。該量測同時看到連線橫幅處於備援模式，因此證據能確認 relay candidate pair 已連線且訊息在同輪送達，但未以 DataChannel 的 `bytesSent`／`bytesReceived` 證明該則訊息實際經 TURN 傳送。來源為 `runs/T2v_smoke-postfix2_20260904T172948Z.md`。
- **R2 TURN 網路映射錯誤**：coturn 行程啟動不等於瀏覽器取得 relay candidate。及格證據只能是 S2 選中的 relay candidate pair 與成功訊息往返。
- **R3 憑證外洩**：log、trace 與報告可能收進環境值。落檔前必須掃描 TURN 使用者名稱、密碼與 URL 中的 credential，發現即停止交付並通報操作者，由操作者處理敏感產物。
- **R4 測試鉤子高估能力**：A2 若直接操作 store 或跳過房籍、簽章、欠條與內容金鑰，只能算模組測試。產品級 E2E 必須走 Vue production 接線。
- **R5 恰好一次回歸**：離線補收與即時路徑重疊可能產生重複。A2 必須以畫面或正式投影輸出計數，不只檢查 store 有資料。
- **R6 中央相依仍在**：階段 A 的 Firestore 名冊與站級 signaling 仍是中央服務。真正的冷啟動備援由階段 B 處理。
- **R7 測試環境誤判**：瀏覽器 E2E 一律由無沙盒 verifier 執行並落檔。Codex 沙盒內的 Chromium 啟動結果不得作為產品狀態證據。
- **R8 PULL 房籍未綁定**：任何能向信使傳送 courier namespace 訊息且知道 `roomId` 的節點，都能拉取該房現存密文，並得知紀錄存在與否、數量及 `senderId` 集合，也可能用重複 `PULL` 放大流量。內容仍需房間金鑰才能解密，但這不構成取回授權。A2 的任何綠燈不得被解讀為「信使取回路徑已授權」；A2 只證明傳輸與補收會運作，不證明存取控制。操作者裁決階段 A 登記但不修，修法納入階段 B 的 protocol 軌 Spec 029。
- **R9 A2 劇本已降級**：A2 驗證的是同一個 context 離開房間後再回來，不是關閉 context 後還原原身分。報告必須清楚寫出這項邊界，不得宣稱驗過 close-context restore 或關閉裝置後還原身分。
- **R10 3 人 mesh 金鑰分發的完成性未定位，已隔離**：90 秒等待下，`mesh-diagnostic.spec.ts` 與 `multi-peer.spec.ts` 兩次 release 實跑都在同一個金鑰就緒斷言逾時。依停損條款未再增加 timeout，兩支測試已用 `test.fixme` 隔離。隔離前另開 trace 的測試撞到 240 秒總 timeout，截斷的 `trace.zip` 沒有可用的 DOM 快照；`mesh-diagnostic` 的 console 過濾器也不含 `keyx` 與 sender key 字樣，因此本輪未取得各 context 房間金鑰狀態收斂的證據。退場前須另行設計取樣方式，取得各 context 的狀態收斂證據並定位根因，再移除兩支測試的 `test.fixme` 並回填本節；在那之前不得宣稱 3 人 mesh 的訊息保證已驗證。重查方向是 sender key 分發、成員間 `keyx` 傳播與各 context 的房間金鑰狀態收斂。來源為 `runs/T2v_release-postfix2_20260904T164224Z.md`。
- **R11 私有房受邀者無法加入，階段 A 不修**：`firestore.rules:281-288` 的讀取規則只允許非私有房、已在 `participants` 的成員或房主讀取房間；`src/services/RoomService.ts:312` 的 `_joinRoomTransaction` 第一步卻是讀取房間文件。私有房受邀者不符合三個條件，因此會收到 `permission-denied`，房主停在 `/waiting/`。verify 的 A/B 實測確認 `isPrivate=true` 時 Bob 被拒且 Alice 停在等待頁，`isPrivate=false` 時可以正常配對。讀取限制自 2026-03-25 存在，smoke 自 2026-08-24 改用 `privateRoom: true` 後即不可能通過；最後一次已知全綠是 2026-07-04。這是影響真實使用者的產品缺陷，不是測試或 TURN 問題。階段 A 不修改，因為 `firestore.rules` 不在本封包允許路徑，而且依 `CLAUDE.md`，master push 會自動把規則部署到 production，屬協作規則第一節第一類的不可逆或對外變更，必須由操作者裁決。修法可能納入同樣處理取用授權的 Spec 029。R11 解決前，V1 relay-only smoke 無法通過。來源為 `runs/T2v_smoke-postfix2_20260904T172948Z.md`。

## 5. 任務分解（tasks）

- [ ] **A1 ⚠ 可信 TURN**：解決 Q1、Q2；使用已安裝的 `/usr/local/bin/turnserver`，由 verifier 以前景行程只綁 `127.0.0.1` 並加上 `--no-cli`、`--allow-loopback-peers`，搭配 repo 外測試 realm、帳密與含本機 TURN 設定的 React dev server；本機 loopback 情境缺少後一個旗標時必定無法互通。執行 S2 relay-only smoke 後關閉 turnserver，落檔原始結果與候選 pair，不用 `brew services` 長駐。只在 `scripts/smoke-report.mjs` 的歸因或輸出確有缺口時修改該檔，不碰部署設定。
- [ ] **A2 ⚠ 信使模擬 E2E**：Q3、Q4 characterization 已完成；依第 4.3 節的修訂劇本，讓 A 以同一個 context 離開房間再回來，並以 B 的獨立 context 寄存到 C 後關閉 B；驗證密文不變、成功率、每跳延遲、離線補收與恰好一次；由 verifier 落檔 T2v 報告。這不證明 close-context restore 或 `PULL` 已完成授權，真實兩台實體裝置場測也未做。
- [ ] **A3 ⚠ 收斂已知 6 項 release 失敗**：先取得同一 SHA 的 trace 並分類。只修證實為時序或選擇器型的項目；四項共用 helper 同形失敗先寫根因，不硬改；最後重跑 release 與三個不回退閘門。

## 6. 驗收（黃金判準）

所有瀏覽器指令由 nerilo-collab-verify 執行，報告寫入 `herdr-packets-Nerilo/runs/`。報告必須含完整指令、HEAD、UTC 起訖、exit code、數字來源與失敗第一行。

- [ ] **V1 relay-only smoke 綠**
  - 指令：先啟動載入本機 TURN 設定的 React dev server，再執行 `SMOKE_BASE_URL=http://127.0.0.1:<port> npm run smoke:prod`。
  - 數字來源：`smoke-artifacts/results.json` 的 S2 測試狀態、`smoke-artifacts/stats.jsonl` 的 `S2-forced-turn`，以及 `smoke-artifacts/SMOKE-REPORT.md`。
  - 及格線：指令 exit code 為 0；S2 為 PASS；至少一個選中 candidate pair 的 `local` 為 `relay`；訊息往返成功且有 `latencyMs`。結果落入 `runs/T2v_smoke-prod_<UTC>.md`。只有 coturn 行程存活或只有 relay candidate 不算通過。

- [ ] **V2 信使模擬 E2E 有落檔數字**
  - 指令：`firebase emulators:exec --only auth,firestore --project nerilo "playwright test --config playwright.vue.config.ts tests/e2e-vue/peer-relay-complete.spec.ts --workers=1"`。
  - 數字來源：測試輸出的 `PEER_RELAY_METRICS=<json>`、Playwright list reporter 與 test attachment，由 verifier 彙整成 `runs/T2v_peer-relay-complete_<UTC>.md`。
  - 及格線：指令 exit code 為 0；至少 5 次完整嘗試；`successRate` 為 100%；`duplicateCount` 為 0；每則預期訊息補收後恰好一次；報告同時列出寄存與補收兩跳的 p50/p95 延遲。報告必須明寫「真實兩台實體裝置場測未做」。

- [x] **V3 React release 實際執行的 24 項全數通過**
  - 指令：`npm run test:e2e:release`。
  - 數字來源：Playwright list reporter 摘要與 `runs/T2v_release-postfix2_20260904T164224Z.md`。
  - 及格線：總數維持 27，skip 固定為 3 項，只允許 `security.spec.ts` P2.6、`mesh-diagnostic.spec.ts` 與 `multi-peer.spec.ts`。其餘 24 項須全數通過、0 項失敗，且指令 exit code 為 0；不得出現本節未列出的新增 skip。隔離後實測為 24 過、0 敗、3 skip，exit code 0。若測試總數或隔離清單改變，須先更新本 spec 的分母與理由。
  - 隔離退場條件：P2.6 取得完整 trace 並定位根因後，移除 `test.fixme` 並回填本節；在那之前不得把它算進通過數，也不得宣稱 leaveRoom 規則已驗證。兩支 R10 測試依第 4.5 節 R10 的退場條件處理。

- [ ] **V4 三個既有閘門維持全綠**
  - 指令：`npm run test:e2e:stable`、`npm run test:e2e:vue-stable`、`npm run test:e2e:rendezvous`。
  - 數字來源：各次 Playwright list reporter 摘要與對應的 `runs/T2v_test-e2e-<gate>_<UTC>.md`。
  - 及格線：stable 11/11、vue-stable 13/13、rendezvous 1/1，均為 exit code 0，且無失敗或跳過。基線分別來自 `runs/T1v_test-e2e-stable_20260904T060341Z.md`、`runs/T1v_test-e2e-vue-stable_20260904T060557Z.md`、`runs/T1v_test-e2e-rendezvous_20260904T061056Z.md`。若測試總數改變，先更新本 spec。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節階段 A 的需求，並把網路層 TURN 與應用層信使分開驗證。
- [x] 第 5 節 A1、A2、A3 完整對應第 4 節；階段 B、C 沒有提前編造任務或驗收數字。
- [x] 第 6 節四項驗收均有指令、數字來源與及格線，且基線只引用 T1v 報告。
- [x] 憲法 16 條均已套用。四條不變量逐項聲明；運作中路徑標 ⚠；重大取捨須回填 ADR；誠實邊界與外部相依已列出。
- [ ] Q1 至 Q5 尚未全數清空。進入相關實作前，先完成該題 characterization 並依憲法第 16 條回填本 spec。

### 7.1 憲法 16 條逐條對照

| 條次 | 本 spec 的落點 |
|---|---|
| 1 定位是層 | 第 1 節只定義可嵌入的傳遞與信使路徑，不把 Nerilo 寫成獨立 App |
| 2 隱私與韌性 | 第 1.1、1.3 節要求密文轉達、中央失效備援與能力邊界 |
| 3 目標函數 | 第 1.3 節逐項說明補助競爭力、可維運、可嵌入、隱私韌性 |
| 4 四條不變量 | 第 1.3 節逐條說明影響，恰好一次與 E2EE 有直接驗收 |
| 5 誠實條款 | 第 2 節禁止延長 timeout、增加 retry 或放寬斷言；第 4.4 節保留產品缺陷紅燈 |
| 6 characterization-first | Q4、Q5 與 A2、A3 均要求先釘現況再改運作中路徑 |
| 7 邊界工具化 | 第 1.3 節限制 SDK 公開表面，第 2 節維持 PARK 與核心分層圍籬 |
| 8 架構決策落 ADR | StoreAndForward 解凍、B0 協定、C0 選路若改重大取捨，必須同步回填 ADR |
| 9 黃金測試 | 第 6 節 V1 至 V4 都是可執行閘門，包含既有 release 與三條穩定基線 |
| 10 邊界揭露 | 第 1.1、2、3、4.5 節列出做不到的能力、外部相依與風險 |
| 11 台灣用語 | 本文使用介面、資料、程式碼、專案、佇列與快取等台灣用語 |
| 12 對外用語 | 本文不用 em-dash、emoji 或口號式排比；測試數字只引用 T1v 報告 |
| 13 commit 風格 | A0 由 impl 留未提交 diff，lead 提交時須用 `[master] 動詞開頭一句話`，不加 AI 署名 |
| 14 先 spec 後實作 | 本檔是 T-002 的 A0，A1 至 A3 尚未開始修改程式 |
| 15 雙軌規格 | 第 1 節說明階段 A 採 feature 軌；B0 若改互通格式須改走 protocol 軌 |
| 16 活文件 | 第 3、7 節要求 characterization 與實作發現落差時先修 spec，不默默偏離 |

## 8. 階段 B：陌生人介紹與本地會合互為備援

**待擴充，B0 時補齊。**

目標是讓任一在線成員都能介紹陌生人，不限房主，並讓介紹路徑與 Spec 027 本地會合點互為備援。本地會合點不可用時可走既有成員介紹；沒有可用介紹人時可走本地會合點或雙向 QR。

已知邊界如下：

- 陌生人初次配對仍必須有本地會合點、雙向 QR 或既有成員介紹之一。階段 B 不承諾零會合媒介的第一次接觸。
- B0 必須定義誰可介紹、介紹憑證、有效期、撤銷、拒絕條件與重放防護。介紹人視為不可信管道，沿用 ADR-0032 的加密與簽章原則。
- B0 若新增或修改跨實作格式，改走 protocol 軌，補版本與相容策略。
- 本節現在不設定驗收數字，也不把目標寫成已完成能力。

## 9. 階段 C：依網路品質選擇信使

**待擴充，C0 時補齊。**

目標是以 RTT、丟包、在線時長與頻寬估計建立品質分數，將 `PeerScoring` 與 `RelayDirectory` 接到實際選路，並在信使失效時自動切換。

已知邊界如下：

- `PeerScoring` 現有 delivery、first arrival 與 mesh presence 訊號，不代表 RTT、丟包與頻寬估計已完整接線。C0 必須逐項核對資料來源與可信度。
- 自報品質可能被偽造。C0 要先定義可觀測量、更新頻率、防抖、切換條件與身分信任邊界。
- C 階段不解凍 super-node、ledger 或 `src/core/relay/onion/`。
- 本節現在不設定切換秒數或成功率門檻，也不把自動選路寫成已完成能力。
