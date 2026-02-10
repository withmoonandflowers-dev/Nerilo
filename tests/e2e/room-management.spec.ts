import { test, expect } from '@playwright/test';

test.describe('房間管理', () => {
  test('創建新房間時應該關閉同一用戶的其他所有房間', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.role-badge')).toContainText(/guest|user/, { timeout: 5_000 });

    // 創建第一個房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();
    await expect(page).toHaveURL(/\/waiting\/(.+)/, { timeout: 10_000 });
    const firstRoomUrl = page.url();
    const firstRoomId = firstRoomUrl.match(/\/waiting\/(.+)/)?.[1];

    // 返回 dashboard
    await page.goto('/dashboard');

    // 創建第二個房間
    await page.getByRole('button', { name: '+ 建立新房間' }).click();
    await page.getByRole('button', { name: '建立房間' }).click();
    await expect(page).toHaveURL(/\/waiting\/(.+)/, { timeout: 10_000 });
    const secondRoomUrl = page.url();
    const secondRoomId = secondRoomUrl.match(/\/waiting\/(.+)/)?.[1];

    // 確認 URL 不同（表示創建了新房間）
    expect(secondRoomId).not.toBe(firstRoomId);

    // 第一個房間應該已經被關閉（狀態變為 closed）
    // 嘗試訪問第一個房間，應該被導航回 dashboard
    await page.goto(`/chat/${firstRoomId}`);
    await expect(page).toHaveURL('/dashboard', { timeout: 5_000 });
  });

  test('等待頁面應該在第二個人加入時自動轉到聊天頁面', async ({ browser }) => {
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
    await expect(pageA.getByText('等待連線')).toBeVisible();
    const roomUrl = pageA.url().replace('/waiting/', '/chat/');

    // B 加入房間
    await pageB.goto('/dashboard');
    await expect(pageB.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageB.goto(roomUrl);

    // 雙方都應該自動轉到聊天頁面（在 15 秒內）
    await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

    // 確認雙方都在聊天頁面
    await expect(pageA.getByText('聊天室:')).toBeVisible();
    await expect(pageB.getByText('聊天室:')).toBeVisible();

    await contextA.close();
    await contextB.close();
  });

  test('兩個使用者可以成功連線並互相發送多條訊息', async ({ browser }) => {
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

    // B 加入
    await pageB.goto('/dashboard');
    await expect(pageB.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageB.goto(roomUrl);

    // 等待雙方連線（真實環境下 WebRTC/ICE 可能需 45–60s）
    await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageA.getByText('已連線')).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByText('已連線')).toBeVisible({ timeout: 60_000 });

    // A 發送第一條訊息
    const message1 = 'Message 1 from A';
    await pageA.getByPlaceholder('輸入訊息...').fill(message1);
    await pageA.getByRole('button', { name: '傳送' }).click();
    await expect(pageB.getByText(message1)).toBeVisible({ timeout: 10_000 });

    // B 回覆
    const message2 = 'Message 2 from B';
    await pageB.getByPlaceholder('輸入訊息...').fill(message2);
    await pageB.getByRole('button', { name: '傳送' }).click();
    await expect(pageA.getByText(message2)).toBeVisible({ timeout: 10_000 });

    // A 發送第二條訊息
    const message3 = 'Message 3 from A';
    await pageA.getByPlaceholder('輸入訊息...').fill(message3);
    await pageA.getByRole('button', { name: '傳送' }).click();
    await expect(pageB.getByText(message3)).toBeVisible({ timeout: 10_000 });

    // B 發送第二條訊息
    const message4 = 'Message 4 from B';
    await pageB.getByPlaceholder('輸入訊息...').fill(message4);
    await pageB.getByRole('button', { name: '傳送' }).click();
    await expect(pageA.getByText(message4)).toBeVisible({ timeout: 10_000 });

    // 確認所有訊息都在雙方的聊天記錄中
    await expect(pageA.getByText(message1)).toBeVisible();
    await expect(pageA.getByText(message2)).toBeVisible();
    await expect(pageA.getByText(message3)).toBeVisible();
    await expect(pageA.getByText(message4)).toBeVisible();

    await expect(pageB.getByText(message1)).toBeVisible();
    await expect(pageB.getByText(message2)).toBeVisible();
    await expect(pageB.getByText(message3)).toBeVisible();
    await expect(pageB.getByText(message4)).toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});
