import { test, expect } from '@playwright/test';

test.describe('房間關閉狀態處理', () => {
  test('訪問已關閉的房間應該導航回 dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    // 創建一個房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();
    await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const roomUrl = page.url();
    const roomId = roomUrl.match(/\/waiting\/(.+)/)?.[1];

    // 取消房間（關閉它）
    await page.getByRole('button', { name: '取消房間' }).click();
    await expect(page).toHaveURL('/dashboard');

    // 嘗試訪問已關閉的房間
    await page.goto(`/chat/${roomId}`);
    
    // 應該被導航回 dashboard
    await expect(page).toHaveURL('/dashboard', { timeout: 5_000 });
  });

  test('創建新房間時應該關閉舊的 waiting 房間', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    // 創建第一個房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();
    await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const firstRoomUrl = page.url();
    const firstRoomId = firstRoomUrl.match(/\/waiting\/(.+)/)?.[1];

    // 返回 dashboard
    await page.goto('/dashboard');

    // 創建第二個房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();
    await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const secondRoomUrl = page.url();
    const secondRoomId = secondRoomUrl.match(/\/waiting\/(.+)/)?.[1];

    // 確認是不同的房間
    expect(secondRoomId).not.toBe(firstRoomId);

    // 嘗試訪問第一個房間（應該已被關閉）
    await page.goto(`/chat/${firstRoomId}`);
    
    // 應該被導航回 dashboard
    await expect(page).toHaveURL('/dashboard', { timeout: 5_000 });
  });

  test('兩個使用者加入後，房間不應該被關閉', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // A 建立房間
    await pageA.goto('/dashboard');
    await expect(pageA.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
    await pageA.getByRole('button', { name: '建立房間' }).click();

    await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const roomUrl = pageA.url().replace('/waiting/', '/chat/');

    // B 加入房間
    await pageB.goto('/dashboard');
    await expect(pageB.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageB.goto(roomUrl);

    // 雙方都應該轉到聊天頁面
    await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

    // 等待連線建立
    await expect(pageA.getByText('已連線')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText('已連線')).toBeVisible({ timeout: 30_000 });

    // 房間應該保持 open 狀態，不應該被關閉
    // 可以通過發送訊息來驗證房間仍然可用
    const message = 'Test message';
    await pageA.getByPlaceholder('輸入訊息...').fill(message);
    await pageA.getByRole('button', { name: '傳送' }).click();
    await expect(pageB.getByText(message)).toBeVisible({ timeout: 10_000 });

    await contextA.close();
    await contextB.close();
  });
});
