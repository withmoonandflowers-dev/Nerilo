# Nerilo 現況（單一事實來源）

> 最後更新：2026-08-24（0.11.0 就緒未發佈：共享狀態＋檔案傳輸＋資料類型指南；壓力驗證過——transport stress 8 例、瀏覽器 32/64MB 傳輸與並行狀態寫入全過）。README、開發文件、跨機器 handoff 與 roadmap 若涉及「現在做到哪」或測試數字，以本檔為準；ADR 與 spec 仍是設計決策與功能驗收的權威來源。

## 定位與交付面

- Nerilo 是可嵌入的 P2P 韌性資料傳遞層；聊天是參考應用，不是最終產品邊界。
- repo 已於 2026-07-16 轉為公開（Apache-2.0）；GitHub Actions 額度限制解除。
- SDK `0.10.0` 已於 2026-08-24 發佈 npm；三個進入點（nerilo／nerilo/firestore／nerilo/transport）乾淨環境安裝驗證過（16/5/2 執行期匯出）。含狀態 API（Spec 024）、房間目錄（Spec 014）、遊戲原始通道（Spec 023）；IChatEngine 破壞性變更見 CHANGELOG。API 在 0.x 階段尚未鎖定。
- React 版仍是 Firebase Hosting production；Nuxt/Vue 接班版已有隔離的 `nerilo-staging` 手動 preview pipeline，但尚未取得切 production 資格，也尚未由本機完成首次 preview deploy。
- Firebase Functions 未部署。Hosting 與 Firestore rules/indexes 由 master push workflow 部署；需 Blaze／Cloud Build 的 Functions 能力仍刻意排除。
- Lemon Squeezy／Netlify webhook 付款鏈已驗證，但 store 仍在 test mode。Pro 首個伺服器端強制權益＝房間容量 10 人（Spec 011）；發放路徑補完（2026-07-18）：手動發放 scripts/grant-plan.mjs、web-vue 建房 sheet 升級入口（PlanCapacityLine）、兩線付款後 focus 強制刷新 token、rules 整合測試 token.plan 五例。

## 已驗證基線

| 層級 | 最新基線 |
|---|---|
| Core quality | TypeScript、ESLint gate 通過；**1570 tests** 全綠（既有 7 warnings；實測 2026-08-03） |
| SDK | build 通過；入口 Firebase isolation 硬閘通過（進入點已改 `core/messaging/MeshChatService`，靜態圖 44 檔）；`qa:pack-smoke` 純 Node 消費者可載入兩個進入點 |
| Firestore rules | Emulator-backed **54/54**；含 room takeover、非成員 signal injection、收件人資格、payload 形狀／大小回歸 |
| React P0 E2E | Emulator-backed **6/6**（2026-08-03；建房、加入、E2EE 握手、雙向訊息、離房） |
| Nuxt quality | `nuxt typecheck`、`nuxt generate` 通過 |
| Nuxt stable E2E | `@vue-stable` 9/9 本機基線，固定 1 worker 隔離 spec；兩週 CI 觀察尚未完成 |
| Spec 001 affected E2E | 真 WebRTC＋Firebase emulator 欠條計量 1/1 |

## 2026-08-03 授權與 AI gateway 收斂

- 修正 `p2pRooms` update 規則：不再以「更新後 participants 含自己」當授權；join、leave、
  owner migration、成員活性與 own mesh identity 各自按操作形狀驗證。原先已登入陌生人可在
  同一次 update 把自己設為 owner 並移除原成員，現有攻擊回歸測試釘住拒絕結果。
- `signals` create 現在要求 sender 是房內成員；明確 `to` 必須是房內成員。WebRTC initiator
  尚未知 remoteUid 時只允許 `offer`／`ice` 使用 `to:null` 房內廣播。SDP、ICE 與 top-level
  欄位改採 allowlist 和實際字串長度限制，不再誤把 `Map.size()` 當 byte 大小。
- Firebase deploy workflow 新增 rules integration 與 P0 browser E2E 兩道硬閘；App Check site key
  也進入 build env（仍須專案擁有者在 Firebase Console 設定 secret／啟用 enforcement）。
- MCP v0.2 可由 stdio AI client 掛載，公開七個意圖工具；新增 capability truth、固定 agent
  identity、read-only／room allowlist／訊息長度 policy、cursor 與 stderr audit。預設 runtime
  仍是無網路、無持久化、無 E2EE 的 in-process demo；真 P2P 路徑採 browser bridge 設計，
  尚未宣稱完成。詳見 `docs/MCP-GATEWAY.md`。

## 2026-08-02 mesh 正確性收斂（Spec 016/017）

- **Spec 017（done）**：rejoin flake 根因＝產生方 keyx 不封給自己，重進後 hydrate 開不回
  金鑰 → epoch 0 重發撞代。修：封裝對象含 self。rejoin E2E 修前 10 輪 6 紅、修後 10/10。
- **Spec 016（done，2026-08-03 CI 7p 三連綠收口）**：7p 連線成形三層修復，確定性互選（circulant，
  `circulantTopology.ts`）、入站 offer 反應式應答、signaling 訂閱視窗 50→400。
  成形層確定性模擬 1600 seed 落地（補 Spec 011 只驗擴散層的證據缺口）。
  迴歸全綠（單元 1558、3 人矩陣×3、@vue-stable、React @stable）；7p 單機量測顯著
  改善但未全綠（R-g 資源上限），驗收移至 `e2e-7p.yml`（手動＋每日排程）。ADR-0037。
- **Spec 018（done，2026-08-03 CI 7p R6-R8 三連綠）**：產生方交接 epoch 碰撞（Spec 016 殘留 E）修復，
  keyx 分發基底改 max(已安裝, 已觀察 metadata)+1＋交接寬限閘門；新加入者開不了舊
  keyx（前向保密）但讀得到 epoch 明文，交接必單調。單元 1562 全綠、rejoin 8 輪 7 綠
  （單次傳輸尾巴）、3 人矩陣綠。ADR-0023 修訂八。
- **Spec 019（done，2026-08-03）**：分島自癒（Spec 016 殘留 D），重連快車道耗盡改降
  30s 慢車道持久重試，出列以當下 snapshot 的互選目標集為準；size>=k 誤殺一併修。
  分島最壞自癒從「永不」→ ~30s。
- **Spec 020（done，2026-08-03）**：rejoin 重建截止改「有進展就續等」，修掉 15s 盲砍與
  13-15s 實測握手重疊的誤殺（rejoin 8 輪 1 紅 → 8/8）。ADR-0023 修訂九。
- 兩顆 timing flake 同日先行收斂：GossipKeyx 單 tick 斷言、setupUser hydration 點擊落空。
- **mesh-e2ee 已定案並修復（2026-08-03）**：覆蓋缺口補上（`e2e-e2ee.yml`，每日 04:45）
  後即揪出根因＝測試讀 Spec 009 已停用的死表 `records`（活表為 `records2`），產品側正常；
  測試改讀 `records2`，本機 2/2 綠、CI run#4 綠。兩個單 spec workflow 併用 `_warmup` 純路由預熱。詳見 QA-REPORT 已知限制。

- `core/relay/onion/`（11 檔，約 2,900 行）移出並凍結，出站路徑死的，卻每場 mesh 跑一次
  NAT 偵測＋三組計時器。留下 `types`／`PeerScoring`／`RelayDirectory`／`CongestionPricing`
  與整組 courier 寄存經濟（各有活的呼叫端，查證後不可一起搬）。
- `core/chain`(936)、`core/protocol`(91) **刪除**；`core/features`(447) 補進 PARK 圍籬。
- `MeshChatService`／`encryptionGate`／`fallbackDecrypt` 從 `features/chat` 搬進
  `core/messaging`。SDK 不再有任何路徑（含動態 import）穿過 `src/features`，
  由 `fitness.architecture.spec.ts` 的動態 import 掃描把關（ESLint 射程外）。

## 待辦：React 產線退役（2026-08-01 之後）

使用者 2026-07-26 決定延到 Vue 硬閘期滿再處理。**前置條件今日已清乾淨**：

- 引擎已搬離 `src/features`，刪 React 產線不會打斷 SDK 公開契約（這是原本最大的風險）。
- 動態 import 圍籬已補，刪除後若有殘留引用會被測試抓到。
- 尚待：Vue `@vue-stable` 觀察期至 2026-08-01、P0/P1 parity 清零、Vue production smoke
  三路全綠、視覺驗收與可回退 artifact（ADR-0017 門檻，缺一不可）。
- 屆時可刪：`src/features`（React UI 部分）、`src/pages`、`src/components`、`src/contexts`、
  `src/hooks` 共約 7,000 行，以及 `tests/e2e/` 的 React 專屬 spec。

## 目前完成度

### 核心傳輸

- 2 人與 mesh 聊天、E2EE、fallback 密文、因果順序、去重與 TURN production smoke 已有可執行證據。
- Spec 009（2026-07-18）：sessionEpoch 入簽章收斂跨會話重放（R1 閉環）。
  gossip 協議升 v2（v1 不互通，GOSSIP_HELLO 版本訊號＋fail-visible 提示）；去重鍵與
  anti-entropy digest 全面分代；NeriloReplica Dexie v2 原子遷移（legacy=0 代只供本機）；
  信使回填加驗簽＋epoch 閘門。產品面代價（使用者拍板）：跨會話補歷史能力放棄。
  conformance 向量 C1-C7 落地 `tests/unit/SessionEpochConformance.spec.ts`；殘留清單
  見 QA-REPORT 已知限制與 ADR-0033。
- Spec 012（2026-07-18）收斂 mesh 群組 E2EE 第二階段：出口閘（金鑰未就緒不送明文、就緒自動補送、逾時 60s 轉 fail-visible）、hydrate 重放 keyx（重載不再重開明文窗）、盲信使推收兩側拒明文（keyx 豁免，協議規則）、React mesh 橋接/備援止血改密文、GX3 安全分級原語（core/security/securityLabel，EncryptionState 改衍生）；TreeKEM/GroupKeyManager 退役（ADR-0034）；金鑰輪替口徑寫入 THREAT_MODEL（在籍者可解全歷史為刻意取捨）。
- partial mesh（7-20 人檔）已接線（Spec 011／ADR-0035，2026-07-18）：第 7 人起
  k=max(3,⌈√n⌉)、fanout 3、ttl 3，拓撲只升不降；房間容量分層 Free 5／Pro 10
  （maxParticipants 欄位＋rules token.plan 驗證）。證據分層：n=7..10 確定性模擬
  1100 組 seed（含 churn＋晚到者）全收斂；7 人 E2E spec 已落地（未入 @vue-stable），
  單機高負載下已實證 7 頁全數切 partial-mesh 與 Pro 容量 rules，惟恰好一次矩陣
  因 WebRTC 遭 CPU 排擠尚未穩定轉綠，殘留與重跑指引見 Spec 011 V1；
  super-node（>20）維持凍結。
- SDK 已抽出公開入口、quickstart 與 minimal example，且不會從 eager import 偷帶 Firebase。
- PARK 模組（`game/`、`community/`、`transport/`、`ledger/`、`core/features/`、`relay/onion/`）
  皆「已測但未接進產品流」，由 ESLint 圍籬凍結；**不可把單元測試等同 production 接線**，
  2026-07-26 的洋蔥路由事件正是這個誤判的實例。

### 信使寄存經濟（Spec 001）

- T1：寄存不刷新 LRU；per-簽章身分占用統計。
- T2：分散式擁擠定價、byte-day 計價、一價收斂測試；QUOTE 請求頻率不能操縱調價。
- T3：QUOTE、本人簽發寄存欠條、per-發票人未結上限與拒收。
- T4：有明確對象的服務欠條可在原發票人、目前持有人、新持有人三方同意後交換；自己的欠條只有本人簽署才結清。
- T5：單一垃圾身分耗盡授信後連續 19 筆拒收，誠實房未被擠出。
- T6／V4 已收口：ADR-0029 與 Protocol Spec 003 v1 固定格式；零授信信使拒收時，本地權威紀錄保留，兩成員仍經正式 anti-entropy 原語雙向補齊。
- ADR-0030／Spec 004 已補同一瀏覽器耐久：寄存債權、服務欠條與防重放狀態存入 IndexedDB，重載逐筆重驗；ACK 前雙邊耐久，失敗補償回滾。

這套經濟不是 coin 或全網餘額。每個信使只對自己持有的債權作權威判斷，不同發票人的欠條只有在使用者同意的交換中才具可比價格。

### Nuxt 接班

- CI `vue-quality` 已是硬閘：`nuxt typecheck`＋`nuxt generate`。
- CI `vue-e2e` 的觀察期起算日修正為 2026-07-18（該 job 到 CI #168 才存在，原記的 07-16 尚未建），
  最早 2026-08-01 才可移除 `continue-on-error`。截至 07-26 共 6 次執行全綠（#168-170、#172-174），
  但只分佈在 2 個活躍日。
- `@vue-stable` 已從 2 條擴至 10 條（2026-07-18 新增 Spec 010 遷移窗回歸鎖 `migration-window.spec.ts`，本機連跑 3 次綠）；parity matrix 見 `docs/VUE-PARITY.md`。這不縮短既定觀察期。
- Production 切換完整門檻見 ADR-0017：Vue E2E 硬閘、P0/P1 清零、Vue production smoke 三路全綠、視覺驗收與可回退 artifact，缺一不可。

## 目前優先序

1. React stable CI 已於 2026-07-26 翻硬閘（12 次執行零紅，依據見 `ci.yml` 該 step 註解）。
   Vue stable CI 觀察到 2026-08-01；期間補齊 P0/P1 parity，不提前切 production。
2. 規劃跨裝置加密備份、私鑰復原與多副本合併；本機重載耐久已完成，但不能把複製 JSON 當備份。
3. 由專案擁有者套用原生 TTL policy；成本儀表板、可信總量配額與 cleanup Functions 部署仍需 Blaze／Cloud Billing 決策。
4. 取得真實使用資料後再擴功能；避免 React、Vue、SDK 三面同時發散。

## 已知風險與誠實邊界

- 四線合併驗證（2026-07-18 本機）：`npm run ci` 137 檔/1544 tests 全綠；React
  mesh-diagnostic 5/5；vue e2e @vue-stable 11 條中 8 綠；兩項裁決落地後 migration-window 與 relay-connect 轉綠
  （rejoin 既有 flake 仍偶發）。原 3 紅逐項記錄：
  - `migration-window`：Spec 010×012 語義衝突，**已裁決收斂（2026-07-18 使用者拍板）**：
    縮小測試斷言（既有成員間恆恰好一次、C 加入後訊息全員恰好一次；C×並發格可見與否
    不斷言、收到即不得重複），012 語義與回歸鎖不動。已連 3 次轉綠；Spec 010 V1 同步修訂。
  - `rejoin`：合併前後皆偶發紅（pre-merge 分支實測亦紅），既有 flake，金鑰時序家族。
  - `relay-connect` 後四條：依賴的 `online-node-count` testid 已於 Spec 006（合併前的
    master）砍中繼卡時移除，分叉點即壞，非合併引入。**已裁決收斂（2026-07-18 使用者
    拍板）**：以 `PresenceFooter` 元件補回在線節點數頁尾（presence 機制本就照跑，只補
    UI 掛鉤；誠實條款不做假在線）。relay-connect 全套 7/7 綠。
  - `mesh-diagnostic-7p`：單機 7 瀏覽器負載下連線成形失敗（8 次 ICE restart），
    維持 Spec 011 既記錄的殘留（待低負載機器/CI 重跑）。

- CI 中 React stable E2E 已是硬閘（2026-07-26 翻）；Vue stable E2E 仍是 soft gate，截止日 2026-08-01。
  觀察期先前按日曆走、證據卻只按推送走（07-18 至 07-25 七天零樣本），已加每日 schedule 觸發解耦。
- Nuxt 最大 bundle chunk 約 568 kB；不擋 correctness，但切 production 前應評估載入成本。
- SDP offer/answer 尚未升級為平台級簽章身分；Firebase auth/rules 是現階段信令完整性邊界。
- 信使欠條是每信使本地權威債權簿，同瀏覽器已耐久；跨裝置備份、私鑰復原與多副本合併尚未設計。
- TTL 欄位、rules、設定腳本與 cleanup Functions 程式已就位，但未持 GCP 權限實際套用 TTL，也未升級 Blaze／部署 Functions。
- **Nerilo 不提供寄件者匿名性**（2026-07-26 查證，R11）。洋蔥路由已實作已測但從未接線，
  cover traffic 與 padding 亦未啟用。對外文件、提案、demo 一律不得暗示具備匿名或抗流量分析能力。
- README 的安全摘要不能取代 `docs/THREAT_MODEL.md`；Nerilo 未經第三方安全認證，不適用高風險匿名通訊。
- React 產線的星型→mesh 遷移窗可能無聲掉信、遲到者看不到星型時代歷史（Spec 010 拍板：不修 React，由 Vue 切 production 退役星型棧收斂）。Vue 線無此窗（ADR-0023 P2-③）且有回歸鎖 `tests/e2e-vue/migration-window.spec.ts`，該回歸鎖已列入 ADR-0017 切換門檻。
