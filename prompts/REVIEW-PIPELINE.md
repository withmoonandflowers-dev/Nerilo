# Nerilo 自動化審查流程 (Review Pipeline)

## 概述
本文件定義了 Nerilo 專案的多角色自動化審查流程，確保每次重大變更都經過專業審查。

## 審查角色清單

### 專業審查（人工觸發）

| # | 角色 | Prompt 檔案 | 審查頻率 | 關注重點 |
|---|------|------------|---------|---------|
| 1 | 架構師 | `architect-review.md` | 架構變更 | 拓撲、信令、E2EE、Relay、RTDB |
| 2 | 資深工程師 | `senior-engineer-review.md` | 每次 PR | 程式碼品質、TypeScript、遷移完整性 |
| 3 | QA 工程師 | `qa-full-test.md` | 部署前 | 功能測試、Console 錯誤、E2E 流程 |
| 4 | 安全工程師 | `security-engineer-review.md` | 安全變更 | 密碼學、認證、RTDB rules、XSS |
| 5 | UX/UI 設計師 | `ux-reviewer.md` | UI 變更 | 使用者體驗、響應式、無障礙 |
| 6 | DevOps/SRE | `devops-sre-review.md` | 部署前 | CI/CD、監控、可靠性 |
| 7 | 效能工程師 | `performance-engineer-review.md` | 每月 | Bundle、執行時、網路 |
| 8 | 產品經理 | `product-manager-review.md` | 重大功能 | 定位、功能完整性、MVP |

### 深度審計（底層穩定性）

| # | 角色 | Prompt 檔案 | 審查頻率 | 關注重點 |
|---|------|------------|---------|---------|
| 9 | 遊戲 SDK 架構師 | `game-sdk-architect-review.md` | SDK 變更 | ECS、NetworkSync、RNG、host migration |
| 10 | 密碼學審計師 | `crypto-security-audit.md` | 安全變更 | 逐行密碼學審計、key lifecycle、RTDB rules |
| 11 | 穩定性測試生成 | `stability-test-generator.md` | 每次重大變更 | 自動產生缺失的測試 |

### 自動化修正

| # | 用途 | Prompt 檔案 | 觸發方式 |
|---|------|------------|---------|
| 12 | 全面審計 | `run-full-audit.md` | 手動：上線前 |
| 13 | 自動修正 | `auto-fix-and-verify.md` | 手動或 scheduled |

## 使用方式

### 方式一：全面審計（上線前必做）
```
請依照 prompts/run-full-audit.md 執行全面審計
```
這會：健康掃描 → 5 個 Agent 並行審查 → 整合報告 → 自動修正 → 驗證

### 方式二：底層穩定性審查（架構變更後）
```
請並行啟動以下 3 個 Agent：
1. 遊戲 SDK 架構師 (prompts/game-sdk-architect-review.md)
2. 密碼學審計師 (prompts/crypto-security-audit.md)
3. 穩定性測試生成 (prompts/stability-test-generator.md)
```

### 方式三：快速修正（發現問題時）
```
請執行 prompts/auto-fix-and-verify.md 的修正流程
```
或直接：`/fix-errors`

### 方式四：單一角色審查
```
請以 [角色名稱] 的角度審查專案，參考 prompts/[prompt-file].md
```

### 方式五：自動產生測試
```
請執行 prompts/stability-test-generator.md，為缺少測試的模組產生測試
```

## 審查 SOP

### Phase 1：自動化檢查（每次 commit）
```bash
npm run ci          # type-check + lint + unit tests
```

### Phase 2：程式碼審查（每次 PR）
- [ ] TypeScript 編譯通過
- [ ] ESLint 無新 warning
- [ ] 單元測試全過
- [ ] 新功能有對應測試
- [ ] 無 `console.log` 殘留
- [ ] 無 `as any` 新增
- [ ] 無 `Math.random` 在安全模組
- [ ] 無硬編碼的密鑰/憑證

### Phase 3：上線前審查（每次部署）
- [ ] `prompts/run-full-audit.md` 完成
- [ ] 所有 🔴 Critical 項目已修正
- [ ] E2E 測試通過
- [ ] Bundle 大小未異常增長
- [ ] Firebase RTDB rules 已更新並部署
- [ ] .env.local.example 與實際環境變數同步

### Phase 4：上線後驗證
- [ ] Production 環境功能冒煙測試
- [ ] Console 無紅色錯誤
- [ ] P2P 連線可建立
- [ ] 備援模式正常運作
- [ ] Sentry 無大量新錯誤

## 自動化監控

| 系統 | 頻率 | 說明 |
|------|------|------|
| `nerilo-health-check` | 週一至五 9am | tsc + tests + lint 自動檢查 |
| `/fix-errors` | 手動觸發 | 自動診斷修復 TS/test/lint 錯誤 |
| `/pre-deploy-check` | 手動觸發 | 部署前完整品質門檻 |

## Prompt 檔案索引

```
prompts/
├── REVIEW-PIPELINE.md              ← 本文件（流程 SOP）
│
├── 專業審查（8 角色）
│   ├── architect-review.md         ← 架構師
│   ├── senior-engineer-review.md   ← 資深工程師
│   ├── qa-full-test.md             ← QA
│   ├── security-engineer-review.md ← 安全工程師
│   ├── ux-reviewer.md              ← UX/UI
│   ├── devops-sre-review.md        ← DevOps/SRE
│   ├── performance-engineer-review.md ← 效能工程師
│   └── product-manager-review.md   ← 產品經理
│
├── 深度審計（底層穩定性）
│   ├── game-sdk-architect-review.md ← 遊戲 SDK 架構
│   ├── crypto-security-audit.md     ← 密碼學安全
│   └── stability-test-generator.md  ← 測試自動生成
│
└── 自動化修正
    ├── run-full-audit.md            ← 全面審計 Master Prompt
    └── auto-fix-and-verify.md       ← 自動修正 + 驗證
```
