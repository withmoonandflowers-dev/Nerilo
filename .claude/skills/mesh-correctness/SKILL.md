---
name: mesh-correctness
description: Nerilo mesh 正確性殘留收斂工作流——依優先序處理跨會話重放防護（session epoch 入簽章）、遷移窗訊息可靠性、6+ 人拓撲實測、mesh 群組 E2EE 第二階段。當使用者要「處理 mesh 殘留」「跨會話重放」「session epoch」「遷移窗」「擴大房間人數」「mesh E2EE」或任何動到 mesh/gossip/crypto 正確性的工作時使用。本 skill 是排程與驗收標準；實際動手一律經 spec-kit（規格）與 harden-tests（測試防護網）。
---

# Nerilo mesh 正確性殘留收斂

## 為什麼有這個 skill

「恰好一次」已於 2026-07-05 達標，但 QA 第三輪留下四項已知限制（`docs/QA-REPORT-chat.md` 行 139-155）。這些都是**設計錯了很久之後才會被發現**的類型——重放、遷移窗掉信、金鑰域擴張。此 skill 固定四項的優先序、檔案錨點與驗收標準，避免每次進場都重新考古。

## 先讀

- `docs/CURRENT-STATUS.md` — 單一事實來源（現況以它為準，本 skill 描述過時時亦同）。
- `docs/QA-REPORT-chat.md` 行 109-155 — 五根因回歸鎖與四項已知限制的原始記載。
- 憲法：`specs/constitution.md`；四條核心不變量動任何一條都必須先走 spec-kit。

## 殘留清單（優先序 + 錨點）

### 1. 跨會話重放防護（最優先——唯一的安全性缺口）
- 破口：`src/core/mesh/GossipMessageHandler.ts:322-326` 驗簽傳 `maxAgeMs: null`；`src/core/mesh/SecurityManager.ts:60-91` 說明 gossip 路徑為何必須停用時效窗（補送不能過期）。
- 攻擊面：新會話 store 為空，房內鄰居可重放舊會話錄下的合法訊息，重現舊內容或預佔 (sender,seq) 槽位。
- 方向：把 session epoch 納入簽章內容，舊 epoch 簽章天然失效；與 `src/core/crypto/SenderKeyManager.ts:326-338` 的 per-epoch seq 防護銜接。
- 陷阱：epoch 判定不能破壞 anti-entropy 補送（30 分鐘舊訊息補送是根因修復，有回歸鎖在 `tests/unit/GossipMessageHandler.spec.ts`）。

### 2. 遷移窗訊息可靠性
- 錨點：`src/types/index.ts:579-581`（`hostMigrationEpoch`、HostMigrationEvent）；星型→mesh 遷移期送出的訊息屬星型棧，mesh anti-entropy 管不到。
- 注意 `src/core/game/sdk/GameSession.ts` 的 host migration 是另一回事，別混。

### 3. 6+ 人拓撲實測接入
- 錨點：`src/core/mesh/AdaptiveTopologyManager.ts`（≤20 → partial-mesh）、`SuperNodeElection.ts`（有程式、未實測接入產品流）。實務上限 5 人記錄在 `docs/CROSS-MACHINE-HANDOFF.md:162`。

### 4. mesh 群組 E2EE（第二階段）
- 星型路徑已注入 SenderKeyManager（ADR-0004）；mesh 3+ 人群組金鑰與 TreeKEM 仍 dormant；`src/services/FirestoreChatFallback.ts` 備援為明文（UI 已誠實標示）。
- 與 GX3「每通道安全標籤」規劃銜接（ham 頻段禁加密，所以是分級不是一律加密）。

## 工作流（每一項都一樣）

1. **先開規格**：用 spec-kit skill 走 specify→clarify→plan→tasks；這四項全部碰核心不變量，無例外。
2. **先鋪測試**：用 harden-tests skill 確認既有防護網（見下）全綠後才動手；新行為先寫失敗測試。
3. **實作**：動 `src/core/` 時記得 React 線凍結新功能、web-vue 尚未切 production——core 是兩線共用，改動要兩邊都不破。
4. **驗收**（缺一不可）：
   - 單元全綠：`npm run test:run`（基線 124 檔/1421 tests）。
   - 確定性模擬：`tests/unit/antiEntropy.simulation.spec.ts` 多 seed 全過。
   - E2E 診斷：`tests/e2e/mesh-diagnostic.spec.ts` 3 人矩陣連續 5 次全 =1（`npm run test:e2e:ci`，需 Java 21+）。
   - 五根因回歸鎖不動搖：`SecurityManager.spec.ts`、`GossipMessageHandler.spec.ts`。
5. 完成後更新 `docs/CURRENT-STATUS.md` 與 QA-REPORT 的已知限制清單。

## 邊界

- nuxt 釘 4.4.2，不升。
- 不在本 skill 內做 Vue 切換門檻（ADR-0017）的事——那是另一條線。
- 涉及協議格式改動（如簽章內容加 epoch）= 跨實作協議，spec-kit 雙軌規格的 protocol 軌必走。
