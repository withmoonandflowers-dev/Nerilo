# Nerilo 現況（單一事實來源）

> 最後更新：2026-07-18（四線合併：Spec 009/010/011/012）。README、CLAUDE、跨機器 handoff 與 roadmap 若涉及「現在做到哪」或測試數字，以本檔為準；ADR 與 spec 仍是設計決策與功能驗收的權威來源。

## 定位與交付面

- Nerilo 是可嵌入的 P2P 韌性資料傳遞層；聊天是參考應用，不是最終產品邊界。
- repo 已於 2026-07-16 轉為公開（Apache-2.0）；GitHub Actions 額度限制解除。npm 尚未發佈。
- SDK 版本 `0.9.0`，可零 Firebase 嵌入；API 在 0.x 階段尚未鎖定。
- React 版仍是 Firebase Hosting production；Nuxt/Vue 接班版可 type-check、static generate，尚未取得切 production 資格。
- Firebase Functions 未部署。Hosting 與 Firestore rules/indexes 由 master push workflow 部署；需 Blaze／Cloud Build 的 Functions 能力仍刻意排除。
- Lemon Squeezy／Netlify webhook 付款鏈已驗證，但 store 仍在 test mode，且 Pro 目前主要是身分標記，尚無完整伺服器端配額權益。

## 已驗證基線

| 層級 | 2026-07-18 基線 |
|---|---|
| Core quality | TypeScript、ESLint gate 通過；137 test files／1544 tests 全綠（既有 7 warnings；四線合併後實測 2026-07-18） |
| SDK | build 通過；入口 Firebase isolation 硬閘通過 |
| React stable E2E | 2026-07-15 emulator-backed 11/11 |
| Nuxt quality | `nuxt typecheck`、`nuxt generate` 通過 |
| Nuxt stable E2E | `@vue-stable` 9/9 本機基線，固定 1 worker 隔離 spec；兩週 CI 觀察尚未完成 |
| Spec 001 affected E2E | 真 WebRTC＋Firebase emulator 欠條計量 1/1 |

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
  因 WebRTC 遭 CPU 排擠尚未穩定轉綠——殘留與重跑指引見 Spec 011 V1；
  super-node（>20）維持凍結。
- SDK 已抽出公開入口、quickstart 與 minimal example，且不會從 eager import 偷帶 Firebase。
- `game/`、`community/` 與部分 relay/transport 能力仍有「已測但未完整接入產品流」的模組；不可把單元測試等同 production 接線。

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
- CI `vue-e2e` 自 2026-07-16 起觀察，最早 2026-07-30 才可移除 `continue-on-error`。
- `@vue-stable` 已從 2 條擴至 10 條（2026-07-18 新增 Spec 010 遷移窗回歸鎖 `migration-window.spec.ts`，本機連跑 3 次綠）；parity matrix 見 `docs/VUE-PARITY.md`。這不縮短既定觀察期。
- Production 切換完整門檻見 ADR-0017：Vue E2E 硬閘、P0/P1 清零、Vue production smoke 三路全綠、視覺驗收與可回退 artifact，缺一不可。

## 目前優先序

1. 觀察 React stable CI 到 2026-07-27、Vue stable CI 到 2026-07-30；期間補齊 P0/P1 parity，不提前切 production。
2. 規劃跨裝置加密備份、私鑰復原與多副本合併；本機重載耐久已完成，但不能把複製 JSON 當備份。
3. 由專案擁有者套用原生 TTL policy；成本儀表板、可信總量配額與 cleanup Functions 部署仍需 Blaze／Cloud Billing 決策。
4. 取得真實使用資料後再擴功能；避免 React、Vue、SDK 三面同時發散。

## 已知風險與誠實邊界

- 四線合併驗證（2026-07-18 本機）：`npm run ci` 137 檔/1544 tests 全綠；React
  mesh-diagnostic 5/5；vue e2e @vue-stable 11 條中 8 綠；兩項裁決落地後 migration-window 與 relay-connect 轉綠
  （rejoin 既有 flake 仍偶發）。原 3 紅逐項記錄：
  - `migration-window`：Spec 010×012 語義衝突——**已裁決收斂（2026-07-18 使用者拍板）**：
    縮小測試斷言（既有成員間恆恰好一次、C 加入後訊息全員恰好一次；C×並發格可見與否
    不斷言、收到即不得重複），012 語義與回歸鎖不動。已連 3 次轉綠；Spec 010 V1 同步修訂。
  - `rejoin`：合併前後皆偶發紅（pre-merge 分支實測亦紅），既有 flake，金鑰時序家族。
  - `relay-connect` 後四條：依賴的 `online-node-count` testid 已於 Spec 006（合併前的
    master）砍中繼卡時移除——分叉點即壞，非合併引入。**已裁決收斂（2026-07-18 使用者
    拍板）**：以 `PresenceFooter` 元件補回在線節點數頁尾（presence 機制本就照跑，只補
    UI 掛鉤；誠實條款不做假在線）。relay-connect 全套 7/7 綠。
  - `mesh-diagnostic-7p`：單機 7 瀏覽器負載下連線成形失敗（8 次 ICE restart），
    維持 Spec 011 既記錄的殘留（待低負載機器/CI 重跑）。

- CI 中 React stable E2E 與 Vue stable E2E 目前仍是 soft gate；Vue 觀察截止日為 2026-07-30，React 既定檢查日為 2026-07-27。
- Nuxt 最大 bundle chunk 約 568 kB；不擋 correctness，但切 production 前應評估載入成本。
- SDP offer/answer 尚未升級為平台級簽章身分；Firebase auth/rules 是現階段信令完整性邊界。
- 信使欠條是每信使本地權威債權簿，同瀏覽器已耐久；跨裝置備份、私鑰復原與多副本合併尚未設計。
- TTL 欄位、rules、設定腳本與 cleanup Functions 程式已就位，但未持 GCP 權限實際套用 TTL，也未升級 Blaze／部署 Functions。
- README 的安全摘要不能取代 `docs/THREAT_MODEL.md`；Nerilo 未經第三方安全認證，不適用高風險匿名通訊。
- React 產線的星型→mesh 遷移窗可能無聲掉信、遲到者看不到星型時代歷史（Spec 010 拍板：不修 React，由 Vue 切 production 退役星型棧收斂）。Vue 線無此窗（ADR-0023 P2-③）且有回歸鎖 `tests/e2e-vue/migration-window.spec.ts`，該回歸鎖已列入 ADR-0017 切換門檻。
