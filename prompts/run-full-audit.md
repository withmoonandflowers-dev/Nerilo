# Nerilo 全面底層審計 — Master Orchestration Prompt

## 你的任務
你是 Nerilo 專案的首席技術官（CTO）。請對整個底層架構執行一次完整的自動化審計、修正、測試驗證循環。

## 執行流程（嚴格按順序）

### Phase 1：健康掃描（只讀，不修改）
```bash
# 1. TypeScript 編譯
node ./node_modules/typescript/bin/tsc --noEmit 2>&1

# 2. 單元測試
node ./node_modules/vitest/vitest.mjs run 2>&1

# 3. Console.log 殘留
grep -rn "console\.\(log\|warn\|error\)" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v logger.ts | grep -v firebase.ts | grep -v featureLog.ts

# 4. TODO/FIXME
grep -rn "TODO\|FIXME\|HACK\|XXX" src/ --include="*.ts" --include="*.tsx"

# 5. as any 濫用
grep -rn "as any" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules

# 6. Math.random 安全風險
grep -rn "Math\.random" src/core/ --include="*.ts"

# 7. .catch(() => {}) 靜默吞錯
grep -rn "\.catch(() =>" src/core/ --include="*.ts"

# 8. npm audit
npm audit 2>&1 | tail -20
```

記錄所有問題，產出診斷報告。

### Phase 2：啟動 5 個專業審查 Agent（並行）

同時啟動以下 5 個 Agent，每個讀取對應的 prompt 檔案：

1. **架構師** — 讀取 `prompts/architect-review.md`，重點：拓撲、信令、E2EE、Relay、RTDB、Game SDK
2. **安全工程師** — 讀取 `prompts/crypto-security-audit.md`，重點：密碼學實作、金鑰生命週期、RTDB rules、P2P 協定安全
3. **遊戲 SDK 架構師** — 讀取 `prompts/game-sdk-architect-review.md`，重點：ECS、NetworkSync、確定性、host migration
4. **QA 工程師** — 讀取 `prompts/stability-test-generator.md`，重點：測試缺口分析 + 撰寫新測試
5. **效能工程師** — 讀取 `prompts/performance-engineer-review.md`，重點：bundle、runtime、網路、壓力場景

### Phase 3：整合報告

等所有 Agent 完成後，整合為統一報告：

```markdown
# Nerilo 審計報告 — [日期]

## 健康掃描結果
| 指標 | 結果 |
|------|------|

## Critical 問題（必須立即修正）
| # | 問題 | 發現者 | 影響 |

## Warning 問題（建議本週修正）
| # | 問題 | 發現者 | 影響 |

## 測試缺口（需新增測試）
| # | 模組 | 缺少的測試案例 | 優先級 |

## 上線決策
- [ ] 所有 Critical 已修正
- [ ] 無 blocker
- [ ] 可以上線 / 不建議上線
```

### Phase 4：自動修正

根據報告中的 Critical 和 Warning 問題：

1. 逐一修正程式碼（先讀取，再修改）
2. 每修正一個問題，立即跑 `tsc --noEmit` + `vitest run` 驗證
3. 如果修正導致新錯誤，立即回滾並嘗試替代方案
4. 修正完成後提交：`git commit -m "fix: audit — [描述修正內容]"`

### Phase 5：測試驗證

1. 跑完整測試套件，確保 100% 通過
2. 對比修正前後的測試數量（應只增不減）
3. 產出最終確認報告

## 重要規則
- **不要刪除現有測試**（除非測試本身有 bug）
- **不要修改功能行為**（只修 bug、安全漏洞、效能問題）
- **每次修改都要驗證**（tsc + vitest）
- **如果一個問題無法在 3 次嘗試內修復，標記為 BLOCKED 並跳過**
