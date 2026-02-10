# E2E 測試執行指南

## 📋 測試套件概覽

### 現有測試檔案

1. **user-chat.spec.ts** - 2 人聊天基本測試
2. **room-management.spec.ts** - 房間管理測試（3 個測試）
3. **waiting-room.spec.ts** - 等待房間測試（4 個測試）
4. **single-user-room.spec.ts** - 單人房間測試（4 個測試）
5. **mesh-gossip.spec.ts** - Mesh 架構測試（2 個測試）
6. **guest-chat.spec.ts** - Guest 用戶測試
7. **room-closed.spec.ts** - 房間關閉測試
8. **room-timeout.spec.ts** - 房間超時測試
9. **comprehensive-chat.spec.ts** - 完整功能測試套件（新增）

### 測試統計

- **總測試數**：約 30+ 個測試案例
- **覆蓋範圍**：
  - ✅ 認證與權限
  - ✅ 房間生命週期
  - ✅ 連線狀態管理
  - ✅ 訊息功能
  - ✅ 架構選擇
  - ✅ 錯誤處理
  - ✅ 效能測試

## 🚀 執行測試

### 基本命令

```bash
# 執行所有測試
npm run test:e2e

# 執行特定測試檔案
npm run test:e2e -- tests/e2e/comprehensive-chat.spec.ts

# 執行特定測試案例
npm run test:e2e -- tests/e2e/comprehensive-chat.spec.ts -g "認證與權限"

# 並行執行（加速）
npm run test:e2e -- --workers=4

# 查看測試報告
npm run test:e2e -- --reporter=html
```

### 測試模式

#### 1. 快速測試（開發時）
```bash
# 只執行基本功能測試
npm run test:e2e -- tests/e2e/user-chat.spec.ts tests/e2e/room-management.spec.ts
```

#### 2. 完整測試（CI/CD）
```bash
# 執行所有測試
npm run test:e2e
```

#### 3. 特定功能測試
```bash
# 測試 Mesh 架構
npm run test:e2e -- tests/e2e/mesh-gossip.spec.ts

# 測試完整功能
npm run test:e2e -- tests/e2e/comprehensive-chat.spec.ts
```

### 測試選項

```bash
# 設置超時時間
npm run test:e2e -- --timeout=120000

# 只執行失敗的測試
npm run test:e2e -- --only-failed

# 重試失敗的測試
npm run test:e2e -- --retries=3

# 在 UI 模式下運行（可視化）
npm run test:e2e -- --ui

# 調試模式
npm run test:e2e -- --debug
```

## 📊 測試覆蓋範圍

### comprehensive-chat.spec.ts 測試套件

#### 1. 認證與權限
- ✅ Guest 用戶應該被導向登入頁面
- ✅ Guest 用戶無法建立房間（按鈕應被禁用）

#### 2. 房間生命週期
- ✅ 建立房間 → 等待 → 加入 → 聊天 → 離開
- ✅ 建立新房間時應該關閉舊房間

#### 3. 連線狀態管理
- ✅ 連線狀態應該正確顯示：idle → connecting → connected
- ✅ 斷線後應該顯示正確的狀態

#### 4. 訊息功能
- ✅ 應該能夠發送和接收多條訊息
- ✅ 空訊息不應該被發送
- ✅ 應該能夠使用 Enter 鍵發送訊息

#### 5. 架構選擇
- ✅ 2 人應該使用星型拓撲
- ✅ 3 人應該使用 Mesh 架構

#### 6. 錯誤處理
- ✅ 訪問不存在的房間應該被導向 dashboard
- ✅ 訪問已關閉的房間應該被導向 dashboard

#### 7. 效能與壓力測試
- ✅ 應該能夠快速發送多條訊息

## 🔧 測試配置

### playwright.config.ts

```typescript
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000, // 60 秒超時
  expect: {
    timeout: 10_000, // 10 秒超時
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev:test',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_ALLOW_GUEST_CREATE_ROOM: 'true',
    },
  },
});
```

### 環境變數

```bash
# .env.test
VITE_ALLOW_GUEST_CREATE_ROOM=true
VITE_FIREBASE_USE_EMULATOR=true
```

## 📝 測試最佳實踐

### 1. 測試結構

```typescript
test.describe('功能名稱', () => {
  test.beforeEach(async ({ page }) => {
    // 每個測試前的設置
  });
  
  test('測試案例描述', async ({ page }) => {
    // 1. Arrange（準備）
    // 2. Act（執行）
    // 3. Assert（斷言）
  });
  
  test.afterEach(async ({ page }) => {
    // 每個測試後的清理
  });
});
```

### 2. 等待策略

```typescript
// ✅ 好的做法：使用明確的等待
await expect(page.getByText('已連線')).toBeVisible({ timeout: 30_000 });

// ❌ 不好的做法：使用固定延遲
await page.waitForTimeout(5000);
```

### 3. 選擇器策略

```typescript
// ✅ 好的做法：使用語義化選擇器
await page.getByRole('button', { name: '傳送' }).click();
await page.getByPlaceholder('輸入訊息...').fill('Hello');

// ❌ 不好的做法：使用 CSS 選擇器
await page.locator('.send-button').click();
```

### 4. 測試隔離

```typescript
// ✅ 好的做法：每個測試使用獨立的 context
test('測試案例', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  // ...
  await contextA.close();
  await contextB.close();
});
```

## 🐛 調試技巧

### 1. 查看 Console 日誌

```typescript
page.on('console', (msg) => {
  console.log(`[Browser] ${msg.type()}: ${msg.text()}`);
});
```

### 2. 截圖和錄影

```typescript
// 失敗時自動截圖
test('測試案例', async ({ page }) => {
  await page.screenshot({ path: 'screenshot.png' });
});
```

### 3. 暫停測試

```typescript
// 在調試模式下暫停
await page.pause();
```

### 4. 查看網路請求

```typescript
page.on('request', request => {
  console.log('Request:', request.url());
});

page.on('response', response => {
  console.log('Response:', response.url(), response.status());
});
```

## 📈 測試報告

### HTML 報告

```bash
# 生成 HTML 報告
npm run test:e2e -- --reporter=html

# 查看報告
npx playwright show-report
```

### JSON 報告

```bash
# 生成 JSON 報告
npm run test:e2e -- --reporter=json
```

### CI/CD 整合

```yaml
# GitHub Actions 範例
- name: Run E2E tests
  run: npm run test:e2e
  continue-on-error: true

- name: Upload test results
  uses: actions/upload-artifact@v3
  if: always()
  with:
    name: playwright-report
    path: playwright-report/
```

## 🎯 測試優先級

### P0（關鍵功能）
- ✅ 房間建立和加入
- ✅ 2 人聊天
- ✅ 權限控制

### P1（重要功能）
- ✅ 3+ 人 Mesh 聊天
- ✅ 連線狀態管理
- ✅ 錯誤處理

### P2（增強功能）
- ⚠️ 效能測試
- ⚠️ 壓力測試
- ⚠️ 長時間運行測試

## 📚 參考資源

- [Playwright 文檔](https://playwright.dev/)
- [測試最佳實踐](https://playwright.dev/docs/best-practices)
- [調試指南](https://playwright.dev/docs/debug)
