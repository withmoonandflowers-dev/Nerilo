---
name: mesh-correctness
description: Nerilo mesh 正確性殘留收斂工作流——依優先序處理跨會話重放防護（session epoch 入簽章）、遷移窗訊息可靠性、6+ 人拓撲實測、mesh 群組 E2EE 第二階段。當使用者要「處理 mesh 殘留」「跨會話重放」「session epoch」「遷移窗」「擴大房間人數」「mesh E2EE」或任何動到 mesh/gossip/crypto 正確性的工作時使用。本 skill 是排程與驗收標準；實際動手一律經 spec-kit（規格）與 harden-tests（測試防護網）。
---

# Nerilo mesh 正確性殘留收斂

## 為什麼有這個 skill

「恰好一次」已於 2026-07-05 達標，但 QA 第三輪留下四項已知限制（`docs/QA-REPORT-chat.md` 行 139-155）。這些都是**設計錯了很久之後才會被發現**的類型——重放、遷移窗掉信、金鑰域擴張。此 skill 固定四項的優先序、檔案錨點與驗收標準，避免每次進場都重新考古。

**2026-07-18 里程碑：四項全數收斂**（Spec 009/010/011/012，同日合併）。本 skill 保留為歷史錨點與殘留追蹤；新的 mesh 正確性工作一律先開新 spec。

## 先讀

- `docs/CURRENT-STATUS.md` — 單一事實來源（現況與測試基線以它為準，本 skill 描述過時時亦同）。
- `docs/QA-REPORT-chat.md` 行 109 起 — 五根因回歸鎖與已知限制的原始記載與收斂後殘留。
- 憲法：`specs/constitution.md`；四條核心不變量動任何一條都必須先走 spec-kit。

## 殘留清單（四項全數收斂，2026-07-18）

### 1. 跨會話重放防護——已收斂（Spec 009 implemented，R1 已修）
- sessionEpoch 入簽章＋收端 per-sender 現行代門檻（低於現行代完全拒收）；去重鍵與 anti-entropy digest 全面分代 (senderId, sessionEpoch, seq)，「預佔槽位」結構上不可能。gossip 協議升 v2（v1 不互通、GOSSIP_HELLO fail-visible 提示）。
- 產品面代價（使用者拍板）：跨會話補歷史能力放棄；同會話（現行代）補送完好，30 分鐘補送回歸鎖不動。
- conformance C1-C7：`tests/unit/SessionEpochConformance.spec.ts`；殘留（首接觸窗/時鐘倒退/信使槽位）見 QA-REPORT 已知限制與 ADR-0033。

### 2. 遷移窗訊息可靠性——已定案處置（Spec 010／ADR-0036）
- 重分類為 React-only 誠實邊界：Vue 線 3+ 人房自始走 mesh、無星型→mesh 遷移窗；React 線不再投資修復，隨 Vue 切 production 一併關閉。
- Vue 回歸鎖：`tests/e2e-vue/migration-window.spec.ts`；ADR-0017 切換門檻加第 6 點。

### 3. 6+ 人拓撲實測接入——已收斂（Spec 011）
- 房間上限 10 人、Free 5／Pro 10 分層（`maxParticipants`＋rules token.plan 驗證）；7 人起 partial mesh（min(n-1,k) 橋接條件、只升不降政策）；模擬擴至 n=7..10 k-圖＋churn＋晚到者 1100 組 seed 收斂。ADR-0035。
- 殘留：7 人真瀏覽器矩陣需低負載環境重跑（`tests/e2e-vue/mesh-diagnostic-7p.spec.ts`）。

### 4. mesh 群組 E2EE（第二階段）——已收斂（Spec 012）
- 主體早由 ADR-0023 P2 完成（keyx 房間金鑰、nrec1 密文信封、Vue 備援密文）；Spec 012 收斂殘餘缺口：出口閘（無鑰不送、逾時 60s fail-visible）、hydrate 重放 keyx（重載不再重開明文窗）、盲信使推收兩側拒明文（keyx 豁免，協議規則）、React 橋接/備援止血、GX3 安全分級原語（`src/core/security/securityLabel.ts`，EncryptionState 改衍生）。
- TreeKEM/GroupKeyManager 已退役（ADR-0034）；金鑰輪替口徑（在籍者可解全歷史＝刻意取捨）記於 `docs/THREAT_MODEL.md`。
- 殘留：React parity（plaintext 態阻斷確認）留待 Vue 切換決策；RF 通道標籤接線屬 M5。

## 工作流（每一項都一樣）

1. **先開規格**：用 spec-kit skill 走 specify→clarify→plan→tasks；這四項全部碰核心不變量，無例外。
2. **先鋪測試**：用 harden-tests skill 確認既有防護網（見下）全綠後才動手；新行為先寫失敗測試。
3. **實作**：動 `src/core/` 時記得 React 線凍結新功能、web-vue 尚未切 production——core 是兩線共用，改動要兩邊都不破。
4. **驗收**（缺一不可）：
   - 單元全綠：`npm run test:run`（基線數字以 `docs/CURRENT-STATUS.md` 為準）。
   - 確定性模擬：`tests/unit/antiEntropy.simulation.spec.ts` 多 seed 全過。
   - E2E 診斷：`tests/e2e/mesh-diagnostic.spec.ts` 3 人矩陣連續 5 次全 =1（`npm run test:e2e:ci`，需 Java 21+）。
   - 五根因回歸鎖不動搖：`SecurityManager.spec.ts`、`GossipMessageHandler.spec.ts`。
5. 完成後更新 `docs/CURRENT-STATUS.md` 與 QA-REPORT 的已知限制清單。

## 邊界

- nuxt 釘 4.4.2，不升。
- 不在本 skill 內做 Vue 切換門檻（ADR-0017）的事——那是另一條線。
- 涉及協議格式改動（如簽章內容加 epoch）= 跨實作協議，spec-kit 雙軌規格的 protocol 軌必走。
