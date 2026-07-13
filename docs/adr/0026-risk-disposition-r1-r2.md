# ADR-0026：稽核 High 風險 R1/R2 的處置決策

狀態：Accepted
日期：2026-07-13
關聯：docs/audit/core-invariants-assessment.md（R1、R2）、ADR-0023

## 背景

核心不變量稽核（2026-07-13）給出「有條件通過」，兩項 High 級風險需明確處置決策，
否則「有條件」永遠懸著。本 ADR 記錄決策與理由，讓稽核閉環。

## R1：跨會話重放不受時效窗限制

**風險**：GossipMessageHandler 收訊路徑為了「補送不被時效窗誤殺」（重載後 store 為空，
舊訊息補送必須被接受），對簽章驗證放棄了 maxAge 檢查。代價是持有舊簽章訊息的攻擊者
可在新會話將其重放，使舊訊息被重新接受。

**決策：短期風險接受，排修 P1（下個技術迭代）。**

理由：
- 前置條件高：攻擊者需先取得房內完整簽章密文（即已是房間成員或曾攔截密文），且重放
  結果只是「舊訊息重複出現」，內容仍是密文原文，無法偽造新內容（簽章覆蓋密文）。
- 影響是體驗與混淆層級（舊訊重現），不是機密性或完整性破口。
- 正確修法（per-session epoch 或 store floor 跨會話持久化）動到補送核心，需獨立迭代
  與完整回歸，不宜倉促。

修復方向（擇一，實作時再定）：
1. store floor 持久化：seq floor 隨 GossipReplicaStore 落盤，新會話以持久 floor 起算，
   舊 seq 直接拒收。優點：不改 wire 格式。風險：多裝置同身分的 floor 同步。
2. session epoch：訊息帶會話代，舊代訊息僅在 anti-entropy 補送情境接受。改 wire 格式。

驗收：重放攻擊的專項測試（舊會話訊息注入新會話應被拒）轉綠。

## R2：keyx 失敗退明文相容，降級可被誘導

**風險**：房間金鑰交換不可用時（ECDH 缺席、keyx 分發失敗），整房退明文相容模式。
UI 有加密指示燈，但屬被動告知；能選擇性阻斷 keyx 的攻擊者可誘導降級。

**決策：分兩級處置。**

1. **立即（本 ADR 生效即算）**：明文模式屬「相容例外」而非正常狀態。demo 與對外文件
   一律以加密房演示；提案不對明文模式做任何承諾。
2. **排修 P2（fail-visible）— 已落地（2026-07-13）**：降級時 UI 從「指示燈」升級為
   「阻斷式警告」：明文房間須使用者明確確認才能發送，預設拒送。實作：
   - 引擎曝加密狀態 `MeshGossipManager.getEncryptionState()`（encrypted/exchanging/
     plaintext；keyCoordinator=null 即真明文），型別 `EncryptionState` 置於中立 `types`
     層（後端不依賴前端 features，符 no-restricted-imports 合約）。
   - 純邏輯 `encryptionGate.sendDecisionFor`：只有 plaintext 需確認；exchanging/encrypted
     放行（ADR 只針對「明文房間」，暫態交換不硬擋但指示器誠實顯示）。
   - Vue 聊天頁：靜態假鎖頭 → 三態指示器（🔒/🔑/⚠️）；明文房送訊前顯示阻斷式確認 bar
     （「仍以明文送出／取消」，預設不送，取消把內容還回輸入框）；明文房常駐提示。
   - 驗證：encryptionGate + getEncryptionState 單元（含「未初始化→exchanging」「無 ECDH→
     plaintext」）；e2e 正常房指示器到 encrypted、明文閘門不擋加密送出。不改協議層。
   - 已知邊界：production React 版有真指示器但無 plaintext 態/硬確認（且瀏覽器恆有 ECDH →
     真明文罕見），留待 React 版切換前或作為 low-pri parity 補。

理由：立即拔掉明文相容會犧牲舊版互通與 ECDH 不可用環境（老瀏覽器）的可用性；
fail-visible 保留相容性但把「知情同意」交還使用者，符合隱私定位。

驗收：明文房間發送前出現阻斷式確認的 e2e 轉綠。

## 後果

- 稽核報告第 11 節條件 3、4 由本 ADR 滿足（處置決策已記錄）。
- R1 修復與 R2 fail-visible 各為獨立迭代，完成後更新稽核報告狀態。
