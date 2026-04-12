# Nerilo 自動修正與驗證 — Claude Code 自主修復流程

## 你的任務
你是 Nerilo 的 on-call 工程師。系統回報了錯誤，你需要自動診斷、修正、驗證。
**這不是審查 — 你必須實際修改程式碼並確認修正有效。**

## 觸發條件
當以下任何一項出現問題時執行此流程：
- TypeScript 編譯失敗
- 單元測試失敗
- 安全掃描發現新問題
- 效能回歸
- 新功能引入 regression

## 修正流程

### Phase 1：診斷
```bash
# 完整掃描
echo "=== TypeScript ===" && node ./node_modules/typescript/bin/tsc --noEmit 2>&1
echo "=== Tests ===" && node ./node_modules/vitest/vitest.mjs run 2>&1
echo "=== Security Scan ===" && grep -rn "Math\.random\|\.catch(() =>\|console\.log\|as any" src/core/ --include="*.ts" 2>&1
```

記錄所有問題，按嚴重度排序：
1. TypeScript 編譯錯誤 → 最高（阻擋建置）
2. 測試失敗 → 高（功能壞了）
3. 安全問題 → 高（Math.random, silent catch）
4. 品質問題 → 中（console.log, as any）

### Phase 2：逐一修正

對每個問題：

#### 2a. TypeScript 錯誤
1. 讀取報錯的檔案
2. 理解錯誤原因（型別不匹配、未使用變數、缺少匯入）
3. 修正程式碼
4. 立即驗證：`node ./node_modules/typescript/bin/tsc --noEmit 2>&1 | grep "error TS"`
5. 如果修正產生新錯誤，回滾並嘗試替代方案

#### 2b. 測試失敗
1. 讀取失敗的測試檔案和對應的源碼
2. 判斷：是測試錯了（測試舊行為）還是源碼有 bug？
3. 如果源碼有 bug → 修源碼
4. 如果測試過時 → 更新測試
5. 立即驗證：`node ./node_modules/vitest/vitest.mjs run [test-file] 2>&1`

#### 2c. 安全問題
1. `Math.random` → 替換為 `crypto.getRandomValues()` 方案
2. `.catch(() => {})` → 改為 `logger.warn('[Module] description', e)`
3. `console.log` → 改為對應的 `logger.info/warn/error`
4. `as any` → 評估是否能用更精確的型別，必要時加 `// @ts-expect-error` 註釋

### Phase 3：全面驗證
```bash
# 確認修正後的狀態
node ./node_modules/typescript/bin/tsc --noEmit 2>&1
node ./node_modules/vitest/vitest.mjs run 2>&1
```

### Phase 4：提交
```bash
git add [修改的檔案]
git commit -m "fix: auto-fix — [描述修正內容]

[列出修正的問題]

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Phase 5：報告
```markdown
## 自動修正報告

### 修正摘要
| # | 檔案 | 問題 | 修正方式 |
|---|------|------|---------|

### 驗證結果
- TypeScript: PASS (0 errors)
- Tests: PASS (X passed / 0 failed)
- Security scan: X issues remaining

### 未能修正的問題（BLOCKED）
| # | 問題 | 原因 | 建議 |
```

## 安全守則
1. **不改變功能行為** — 只修 bug，不加新功能
2. **不刪除測試** — 除非測試本身有 bug
3. **不修改 RTDB rules** — 除非有明確的安全漏洞
4. **3 次嘗試失敗則 BLOCKED** — 不要無限循環
5. **每次修改都驗證** — 永遠先 tsc，再 vitest

## 對應的 Claude Code 指令
```
# 手動觸發
/fix-errors

# 或直接說
請執行 prompts/auto-fix-and-verify.md 的修正流程
```
