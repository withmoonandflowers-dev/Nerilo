# E2E 測試問題修復說明

## 問題分析

### 主要問題

1. **開發伺服器未自動啟動**
   - **問題**：`playwright.config.ts` 中缺少 `webServer` 配置
   - **影響**：執行 `npm run test:e2e` 時，如果開發伺服器未運行，測試會失敗
   - **原因**：測試配置期望 `http://localhost:4173` 有服務運行，但沒有自動啟動機制

2. **測試檔案中的變數錯誤**
   - **問題**：`tests/e2e/room-management.spec.ts` 中使用了未定義的變數 `firstRoomId` 和 `secondRoomId`
   - **影響**：測試會因為 ReferenceError 而失敗
   - **原因**：從 URL 中提取 roomId 的邏輯缺失

3. **缺少自動化驗證流程**
   - **問題**：沒有 CI/CD 工作流程來驗證測試
   - **影響**：無法在提交代碼前自動驗證測試是否通過
   - **原因**：缺少 GitHub Actions 配置

## 解決方案

### 1. 更新 Playwright 配置

在 `playwright.config.ts` 中添加了 `webServer` 配置：

```typescript
webServer: {
  command: 'npm run dev:test',
  url: 'http://localhost:4173',
  reuseExistingServer: !process.env.CI, // CI 環境中不重用現有伺服器
  timeout: 120_000, // 給伺服器更多時間啟動
  stdout: 'ignore',
  stderr: 'pipe',
},
```

**效果**：
- 執行測試時會自動啟動開發伺服器
- 測試結束後自動關閉伺服器
- 在本地開發時可以重用已運行的伺服器（提高效率）
- 在 CI 環境中確保使用新啟動的伺服器

### 2. 修復測試檔案錯誤

修復了 `tests/e2e/room-management.spec.ts` 中的變數提取邏輯：

```typescript
// 修復前
const firstRoomUrl = page.url();
expect(secondRoomId).not.toBe(firstRoomId); // ❌ 變數未定義

// 修復後
await expect(page).toHaveURL(/\/waiting\/(.+)/, { timeout: 10_000 });
const firstRoomUrl = page.url();
const firstRoomId = firstRoomUrl.match(/\/waiting\/(.+)/)?.[1]; // ✅ 正確提取
```

### 3. 創建 GitHub Actions 工作流程

創建了 `.github/workflows/e2e-tests.yml`，提供：

- **自動觸發**：在 push 和 pull request 時自動運行
- **手動觸發**：可以通過 workflow_dispatch 手動觸發
- **測試結果上傳**：自動上傳測試報告和失敗時的影片
- **環境變數支援**：可以通過 GitHub Secrets 配置 Firebase 環境變數

### 4. 增強 package.json 腳本

添加了更多測試相關腳本：

```json
{
  "test:e2e": "playwright test",           // 基本測試
  "test:e2e:ui": "playwright test --ui",   // UI 模式（可視化）
  "test:e2e:debug": "playwright test --debug", // 調試模式
  "test:e2e:headed": "playwright test --headed", // 有頭模式（顯示瀏覽器）
  "test:e2e:report": "playwright show-report"    // 查看測試報告
}
```

## 使用方式

### 本地開發

1. **運行所有測試**：
   ```bash
   npm run test:e2e
   ```
   伺服器會自動啟動和關閉

2. **可視化測試**（推薦用於調試）：
   ```bash
   npm run test:e2e:ui
   ```

3. **調試模式**：
   ```bash
   npm run test:e2e:debug
   ```

4. **查看測試報告**：
   ```bash
   npm run test:e2e:report
   ```

### CI/CD

GitHub Actions 會自動：
- 在每次 push 和 PR 時運行測試
- 上傳測試結果和失敗影片
- 確保測試環境的一致性

## 驗證步驟

1. **驗證配置**：
   ```bash
   npm run test:e2e
   ```
   應該看到：
   - 開發伺服器自動啟動
   - 測試執行
   - 伺服器自動關閉

2. **驗證修復**：
   ```bash
   npm run test:e2e -- tests/e2e/room-management.spec.ts
   ```
   應該通過，不再出現變數未定義錯誤

3. **驗證 CI**：
   - 提交代碼到 GitHub
   - 檢查 Actions 標籤頁
   - 確認測試自動運行

## 注意事項

1. **環境變數**：
   - 本地測試需要配置 Firebase 環境變數（`.env.local`）
   - CI 環境需要通過 GitHub Secrets 配置

2. **Firebase Emulator**：
   - 如果需要測試 Firebase 功能，可能需要同時啟動 Firebase Emulator
   - 可以考慮在 `webServer` 中同時啟動多個服務

3. **測試穩定性**：
   - WebRTC 測試可能因為網路環境而不穩定
   - 考慮增加重試機制或調整超時時間

## 後續改進建議

1. **添加測試覆蓋率報告**
2. **整合 Firebase Emulator 到測試流程**
3. **添加視覺回歸測試**
4. **優化測試執行時間（並行執行）**
5. **添加測試資料清理機制**
