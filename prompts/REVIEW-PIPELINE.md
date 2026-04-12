# Nerilo 自動化審查流程 (Review Pipeline)

## 概述
本文件定義了 Nerilo 專案的多角色自動化審查流程，確保每次重大變更都經過專業審查。

## 審查角色清單

| # | 角色 | Prompt 檔案 | 審查頻率 | 關注重點 |
|---|------|------------|---------|---------|
| 1 | 架構師 | `architect-review.md` | 每次架構變更 | 拓撲、信令、E2EE、Relay、RTDB |
| 2 | 資深工程師 | `senior-engineer-review.md` | 每次 PR | 程式碼品質、效能、TypeScript、遷移完整性 |
| 3 | QA 工程師 | `qa-full-test.md` | 每次部署前 | 功能測試、Console 錯誤、E2E 流程 |
| 4 | 安全工程師 | `security-engineer-review.md` | 每次安全相關變更 | 密碼學、認證、RTDB rules、XSS |
| 5 | UX/UI 設計師 | `ux-reviewer.md` | 每次 UI 變更 | 使用者體驗、響應式、無障礙 |
| 6 | DevOps/SRE | `devops-sre-review.md` | 每次部署前 | CI/CD、監控、可靠性、災難恢復 |
| 7 | 效能工程師 | `performance-engineer-review.md` | 每月一次 | Bundle、執行時、網路、載入效能 |
| 8 | 產品經理 | `product-manager-review.md` | 每次重大功能完成 | 產品定位、功能完整性、MVP、增長 |

## 使用方式

### 方式一：手動觸發單一審查
```
請以 [角色名稱] 的角度審查專案，參考 prompts/[prompt-file].md
```

### 方式二：全面審查（上線前）
```
請依序執行以下審查流程，每個角色並行啟動 Agent：
1. 架構師 (prompts/architect-review.md)
2. QA 工程師 (prompts/qa-full-test.md)
3. 安全工程師 (prompts/security-engineer-review.md)
4. 資深工程師 (prompts/senior-engineer-review.md)
5. UX/UI 設計師 (prompts/ux-reviewer.md)
6. DevOps/SRE (prompts/devops-sre-review.md)

完成後整合所有報告，產出統一的「上線前 checklist」。
```

### 方式三：快速審查（日常 PR）
```
請以資深工程師和 QA 的角度快速審查最近的變更，
參考 prompts/senior-engineer-review.md 和 prompts/qa-full-test.md。
重點：程式碼品質、測試覆蓋、有無 regression。
```

## 審查流程 SOP

### Phase 1: 自動化檢查（每次 commit）
```bash
npm run ci          # type-check + lint + unit tests
```

### Phase 2: 程式碼審查（每次 PR）
- [ ] TypeScript 編譯通過
- [ ] ESLint 無新 warning
- [ ] 單元測試全過
- [ ] 新功能有對應測試
- [ ] 無 `console.log` 殘留
- [ ] 無 `as any` 新增
- [ ] 無硬編碼的密鑰/憑證

### Phase 3: 上線前審查（每次部署）
- [ ] 全面審查（方式二）完成
- [ ] 所有 🔴 Critical 項目已修正
- [ ] E2E 測試通過
- [ ] Bundle 大小未異常增長
- [ ] Firebase RTDB rules 已更新
- [ ] .env.local.example 與實際環境變數同步

### Phase 4: 上線後驗證
- [ ] Production 環境功能冒煙測試
- [ ] Console 無紅色錯誤
- [ ] Firebase RTDB 連線正常
- [ ] P2P 連線可建立
- [ ] 備援模式正常運作

## 審查報告模板

每次全面審查後，應產出以下格式的報告：

```markdown
# Nerilo 審查報告 — [日期]

## 審查範圍
- Commit: [hash]
- Branch: [branch name]
- 審查角色: [列出參與的角色]

## Critical 問題（必修）
| # | 問題 | 發現者 | 狀態 |
|---|------|--------|------|

## Warning 問題（建議修正）
| # | 問題 | 發現者 | 狀態 |
|---|------|--------|------|

## 改善建議（Nice to have）
| # | 建議 | 發現者 | 優先級 |
|---|------|--------|--------|

## 上線決策
- [ ] 所有 Critical 已修正
- [ ] 無 blocker
- [ ] 可以上線 / 不建議上線（原因：）
```

## 持續改善
- 每次審查後，更新 prompt 檔案以反映新的審查經驗
- 紀錄 false positive 和遺漏，用於改善審查品質
- 每季度評估是否需要新增審查角色
