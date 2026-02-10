import { test, expect } from '@playwright/test';

test.describe('單人房間功能', () => {
  test('單人可以創建房間並進入聊天頁面', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    // 創建房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();

    // 應該進入等待頁面
    await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    await expect(page.getByText('等待連線')).toBeVisible();

    // 點擊「開始聊天」按鈕（如果存在）
    const startChatButton = page.getByRole('button', { name: '開始聊天' });
    if (await startChatButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await startChatButton.click();
      await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
    } else {
      // 或者房間應該自動轉為 open 並進入聊天頁面
      await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    }

    // 確認在聊天頁面
    await expect(page.getByText('聊天室:')).toBeVisible();
  });

  test('單人進入房間後，第二個人加入時應該自動建立連線', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // A 創建房間並進入
    await pageA.goto('/dashboard');
    await expect(pageA.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
    await pageA.getByRole('button', { name: '建立房間' }).click();

    await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const roomUrl = pageA.url().replace('/waiting/', '/chat/');

    // A 應該在等待頁面（單人時不會自動進入聊天頁面）
    // 等待 B 加入後，A 會自動轉到聊天頁面
    await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 5_000 });

    // B 加入房間
    await pageB.goto('/dashboard');
    await expect(pageB.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageB.goto(roomUrl);

    // B 應該進入聊天頁面
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

    // 等待雙方連線建立
    await expect(pageA.getByText('已連線')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText('已連線')).toBeVisible({ timeout: 30_000 });

    // 測試訊息傳輸
    const message = 'Test message from A';
    await pageA.getByPlaceholder('輸入訊息...').fill(message);
    await pageA.getByRole('button', { name: '傳送' }).click();
    await expect(pageB.getByText(message)).toBeVisible({ timeout: 10_000 });

    await contextA.close();
    await contextB.close();
  });
});
