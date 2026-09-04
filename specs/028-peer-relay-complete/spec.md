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

- [ ] **Q1 本機 coturn 的可達位址與 Docker 網路模式**：Docker daemon 目前沒有啟動。操作者啟動後，A1 要先用 `coturn/coturn` 映像確認 macOS Docker 對瀏覽器可達的 TURN 位址、relay port 範圍與 UDP 映射，再把確定的啟動指令回填本節。若本機方案不可達，停止並請操作者提供既有雲端 TURN 憑證；agent 不自行註冊或付款。
- [ ] **Q2 A1 的本機受測站位址**：`playwright.smoke.config.ts` 不會啟動 web server。A1 預設以載入 `.env.local` TURN 設定的本機 React dev server 為 `SMOKE_BASE_URL`，不得打未含本輪憑證的正式站。實作時須把確定的 host、port 與啟動指令回填。
- [ ] **Q3 A2 的兩個 context 拓撲**：本 spec 將需求解讀為「同一時間最多兩個隔離 context」。C 保持在線；另一個 endpoint context 先承載 B 寄存，再關閉並以 A 的既有身分與房間金鑰重開完成補收。若 Playwright 無法在不共用儲存的前提下還原 A，允許建立第三個 context，但任一時刻仍只能有 endpoint 與 C 兩個在線。若這個解讀不成立，先修 spec。
- [ ] **Q4 A2 的資格與呈現層前提**：`CourierServer` 的 `PULL` 目前以 `roomId` 取紀錄，是否已完整綁定請求者的房籍仍未定位。Spec 021 也把「補回後顯示在聊天畫面且恰好一次」列為 planned。A2 實作前要先做 characterization，確認房籍驗證、內容金鑰恢復與 UI 投影各自的現況；若缺口屬產品語義，先更新本 spec，不用測試鉤子繞過。
- [ ] **Q5 A3 五項非 strict-mode 失敗的根因**：T1v 只記錄錯誤形狀，根因均未定位。任何修正前要由無沙盒 verifier 產生同一 SHA 的 trace 與最小重現，再區分時序、選擇器與產品缺陷。

## 4. 技術計畫（plan）

### 4.1 兩條轉達路徑分開驗證

階段 A 不建立一個模糊的「relay」綜合指標。A1 驗證網路層 TURN，受測者是 coturn 與 WebRTC relay-only candidate pair。A2 驗證應用層信使，受測者是 `RelayConnector`、`CourierService`、`CourierStore` 與 Vue 接線。兩份報告分開落檔，延遲數字不得互相替代。

### 4.2 A1 可信 TURN

1. 操作者啟動 Docker daemon，並在 repo 外管理測試帳密。優先使用 `coturn/coturn`，不使用需註冊或付款的服務。
2. 本機 React 站由 `.env.local` 讀取 `VITE_TURN_URLS`、`VITE_TURN_USERNAME` 與 `VITE_TURN_CREDENTIAL`。這些值不得出現在 spec、commit、console 摘要或 T2v 報告。
3. 以 `SMOKE_BASE_URL` 指向本機站執行 `npm run smoke:prod`。`tests/smoke/production.smoke.spec.ts` 的 S2 會把 `iceTransportPolicy` 強制設為 `relay`，並斷言選中的本地 candidate 類型為 `relay`。
4. `scripts/smoke-report.mjs` 讀取 `smoke-artifacts/results.json` 與 `stats.jsonl`，產生 `SMOKE-REPORT.md`。若 S2 沒有統計資料，依第 113 至 119 行先看測試是否在註冊、建房或連線前失敗，不直接判定 TURN 壞掉。

### 4.3 A2 信使模擬 E2E

新增 `tests/e2e-vue/peer-relay-complete.spec.ts`，沿用 `playwright.vue.config.ts` 與 Firebase emulator。測試只走 Vue 現有接線，不新增 React 接線。

受測劇本如下：

1. A 與 B 已透過合法路徑建立房籍與內容金鑰。這是測試前提，不列入信使延遲。
2. A 離線。B 與 C 同時在線，B 無法直接連到 A，只能將合法密文紀錄寄存給 C。
3. B 離線。A 以原身分回線，與仍在線的 C 對帳並補收。量測期間 A 與 B 不同時在線，因此沒有 A 到 B 的直連路徑。
4. 每輪記錄 B 到 C 的寄存延遲、C 到 A 的補收延遲、完整轉達延遲、是否送達、是否重複，以及 C 保存的密文是否逐位元組未變。
5. 至少執行 5 輪。測試輸出單行 `PEER_RELAY_METRICS=<json>`，同時以 `testInfo.attach` 附上 JSON。verifier 將原始指令、UTC 起訖、attempts、delivered、successRate、duplicateCount、每跳 p50/p95 與真實裝置未做聲明寫入 `runs/T2v_peer-relay-complete_<UTC>.md`。

測試不得使用 `depositAndPull` 一步完成整段旅程，也不得直接把密文塞進 A 的本地庫。要透過 production 使用的 `runCourierBackup`、`CourierClient` 與 `CourierServer` 路徑。若 Q4 確認現行 UI 投影尚未完成，先更新本 spec 與 Spec 021 的依賴關係，再決定是否把 A2 拆為傳輸層與呈現層兩個可見結果。

### 4.4 A3 已知 release 失敗

基線只引用 `runs/T1v_test-e2e-release_20260904T055849Z.md`：27 項中 21 項通過、6 項失敗，根因均未定位。

| 測試 | 錯誤第一行 | A3 處置 |
|---|---|---|
| `tests/e2e/chat-flow.spec.ts:17` P1.1 | `Error: expect(locator).toHaveClass(expected) failed` | 先用 trace 判斷狀態未轉移、時序或過期斷言，不先改 timeout |
| `tests/e2e/chat-flow.spec.ts:53` P1.3 | `Error: expect(locator).toBeVisible() failed` | 與 `_helpers/users.ts:190` 同形，先查根因 |
| `tests/e2e/chat-flow.spec.ts:99` P1.5 | `Error: locator.click: Error: strict mode violation: getByRole('button', { name: '傳送' }) resolved to 2 elements:` | 可在單一 spec 內收斂為精確 selector，修後由 verifier 重跑 |
| `tests/e2e/mesh-diagnostic.spec.ts:31` | `Error: expect(locator).toBeVisible() failed` | 與 `_helpers/users.ts:190` 同形，先查根因 |
| `tests/e2e/refresh-recovery.spec.ts:13` P1.10 | `Error: expect(locator).toBeVisible() failed` | 與 `_helpers/users.ts:190` 同形，先查根因 |
| `tests/e2e/security.spec.ts:232` P2.5 | `Error: expect(locator).toBeVisible() failed` | 與 `_helpers/users.ts:190` 同形，先查根因 |

A3 只修已證實為時序或選擇器型的項目。四項 `_helpers/users.ts:190` 同形失敗必須先寫出共同根因與反證，再決定是否需要共用 helper 變更。產品缺陷留紅並登記，不以測試改動掩蓋。

### 4.5 風險與外部相依

- **R1 Docker 不可用**：Docker daemon 現況為未啟動。A1 在操作者啟動前無法產生本機 TURN 證據。
- **R2 TURN 網路映射錯誤**：coturn 行程啟動不等於瀏覽器取得 relay candidate。及格證據只能是 S2 選中的 relay candidate pair 與成功訊息往返。
- **R3 憑證外洩**：log、trace 與報告可能收進環境值。落檔前必須掃描 TURN 使用者名稱、密碼與 URL 中的 credential，發現即停止交付並通報操作者，由操作者處理敏感產物。
- **R4 測試鉤子高估能力**：A2 若直接操作 store 或跳過房籍、簽章、欠條與內容金鑰，只能算模組測試。產品級 E2E 必須走 Vue production 接線。
- **R5 恰好一次回歸**：離線補收與即時路徑重疊可能產生重複。A2 必須以畫面或正式投影輸出計數，不只檢查 store 有資料。
- **R6 中央相依仍在**：階段 A 的 Firestore 名冊與站級 signaling 仍是中央服務。真正的冷啟動備援由階段 B 處理。
- **R7 測試環境誤判**：瀏覽器 E2E 一律由無沙盒 verifier 執行並落檔。Codex 沙盒內的 Chromium 啟動結果不得作為產品狀態證據。

## 5. 任務分解（tasks）

- [ ] **A1 ⚠ 可信 TURN**：解決 Q1、Q2；由操作者啟動 Docker 與提供 repo 外測試帳密；啟動 `coturn/coturn` 與含本機 TURN 設定的 React dev server；由 verifier 執行 S2 relay-only smoke，落檔原始結果與候選 pair。只在 `scripts/smoke-report.mjs` 的歸因或輸出確有缺口時修改該檔，不碰部署設定。
- [ ] **A2 ⚠ 信使模擬 E2E**：先完成 Q3、Q4 characterization；新增 Vue E2E，以同時最多兩個隔離 context 跑 B 寄存到 C、A 回線向 C 補收；驗證密文不變、成功率、每跳延遲、離線補收與恰好一次；由 verifier 落檔 T2v 報告。真實兩台實體裝置場測未做。
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

- [ ] **V3 React release 不低於 21/27**
  - 指令：`npm run test:e2e:release`。
  - 數字來源：Playwright list reporter 摘要與 `runs/T2v_test-e2e-release_<UTC>.md`。
  - 及格線：27 項中至少 21 項通過，失敗不超過 6 項；不可新增 skip。基線來自 `runs/T1v_test-e2e-release_20260904T055849Z.md`。若測試總數改變，先更新本 spec 的分母與理由。

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
