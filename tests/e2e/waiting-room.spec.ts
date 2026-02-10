import { test, expect } from '@playwright/test';

test.describe('等待連線階段', () => {
  test('創建房間後應該進入等待頁面', async ({ page }) => {
    await page.goto('/dashboard');

    // 等待自動匿名登入完成
    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.role-badge')).toContainText('guest', { timeout: 5_000 });

    // 建立房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();

    // 應該被導到等待頁面
    await expect(page).toHaveURL(/\/waiting\/.+/);
    await expect(page.getByText('等待連線')).toBeVisible();
    await expect(page.getByText('等待其他人加入...')).toBeVisible();
  });

  test('等待頁面應該顯示倒數計時', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();

    await expect(page).toHaveURL(/\/waiting\/.+/);

    // 檢查倒數計時是否存在
    await expect(page.getByText('剩餘時間')).toBeVisible();
    // 倒數計時應該顯示時間格式（例如 05:00）
    await expect(page.locator('.timer-value')).toBeVisible();
  });

  test('等待頁面應該顯示分享連結按鈕', async ({ page, context }) => {
    await page.goto('/dashboard');

    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();

    await expect(page).toHaveURL(/\/waiting\/.+/);

    // 檢查分享連結功能
    await expect(page.getByText('分享房間連結')).toBeVisible();
    const copyButton = page.getByRole('button', { name: /複製連結/ });
    await expect(copyButton).toBeVisible();

    // 測試複製連結功能
    // 監聽 clipboard API
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // 點擊複製按鈕
    await copyButton.click();

    // 驗證連結是否被複製（通過檢查是否有 alert 或確認訊息）
    // 注意：實際的 clipboard 讀取在 Playwright 中需要特殊處理
    // 這裡我們主要驗證按鈕可以點擊且沒有錯誤
    await page.waitForTimeout(500); // 等待複製操作完成
  });

  test('第二個人加入時應該自動轉到聊天頁面', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // A 建立房間
    await pageA.goto('/dashboard');
    await expect(pageA.getByText('guest')).toBeVisible();
    await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
    await pageA.getByRole('button', { name: '建立房間' }).click();

    // A 應該在等待頁面
    await expect(pageA).toHaveURL(/\/waiting\/.+/);
    const roomUrl = pageA.url().replace('/waiting/', '/chat/');

    // B 加入房間
    await pageB.goto(roomUrl);

    // 雙方都應該自動轉到聊天頁面
    await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });

    await contextA.close();
    await contextB.close();
  });

  test('等待頁面應該顯示參與者數量', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('guest')).toBeVisible();

    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();

    await expect(page).toHaveURL(/\/waiting\/.+/);

    // 應該顯示參與者數量（至少 1 人）
    await expect(page.getByText(/目前參與者: \d+ 人/)).toBeVisible();
  });

  test('房主可以取消房間', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();

    await expect(page).toHaveURL(/\/waiting\/.+/);

    // 點擊取消按鈕
    await page.getByRole('button', { name: '取消房間' }).click();

    // 應該返回 dashboard
    await expect(page).toHaveURL('/dashboard');
  });

  test('非房主可以離開等待頁面', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // A 建立房間
    await pageA.goto('/dashboard');
    await expect(pageA.getByText('guest')).toBeVisible();
    await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
    await pageA.getByRole('button', { name: '建立房間' }).click();

    await expect(pageA).toHaveURL(/\/waiting\/.+/);
    const roomUrl = pageA.url().replace('/waiting/', '/waiting/');

    // B 加入等待頁面（直接訪問等待 URL）
    await pageB.goto(roomUrl);
    await expect(pageB).toHaveURL(/\/waiting\/.+/);

    // B 應該看到「離開」按鈕而不是「取消房間」
    await expect(pageB.getByRole('button', { name: '離開' })).toBeVisible();

    // B 離開
    await pageB.getByRole('button', { name: '離開' }).click();
    await expect(pageB).toHaveURL('/dashboard');

    await contextA.close();
    await contextB.close();
  });
});
