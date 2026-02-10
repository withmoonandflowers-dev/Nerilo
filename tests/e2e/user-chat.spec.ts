import { test, expect } from '@playwright/test';

test.describe('兩個使用者可以互相連線並發送訊息', () => {
  test('兩個已登入使用者可以建立房間、連線並互相傳訊息', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // 將瀏覽器 console log 帶到測試輸出
    pageA.on('console', (msg) => {
      if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warning') {
        console.log('[A]', msg.type(), msg.text());
      }
    });
    pageB.on('console', (msg) => {
      if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warning') {
        console.log('[B]', msg.type(), msg.text());
      }
    });

    // A 登入並建立房間
    await pageA.goto('/login');
    await pageA.getByRole('button', { name: /Google/i }).click();
    // 等待登入完成（這裡需要實際的 Google 登入流程，在 e2e 測試中可能需要 mock）
    // 為了測試，我們先使用 guest 模式
    await pageA.goto('/dashboard');
    await expect(pageA.locator('.role-badge')).toBeVisible({ timeout: 15_000 });

    await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
    await pageA.getByRole('button', { name: '建立房間' }).click();

    // A 應該在等待頁面
    await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    await expect(pageA.getByText('等待連線')).toBeVisible();
    const roomUrl = pageA.url().replace('/waiting/', '/chat/');

    // B 加入房間
    await pageB.goto('/dashboard');
    await expect(pageB.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageB.goto(roomUrl);

    // 雙方都應該自動轉到聊天頁面
    await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

    // 等待雙方連線狀態為「已連線」（E2E 環境下 WebRTC 建立可能需較長時間）
    await expect(pageA.getByText('已連線')).toBeVisible({ timeout: 45_000 });
    await expect(pageB.getByText('已連線')).toBeVisible({ timeout: 45_000 });

    // A 傳送訊息，B 應該看到
    const messageFromA = 'Hello from User A';
    await pageA.getByPlaceholder('輸入訊息...').fill(messageFromA);
    await pageA.getByRole('button', { name: '傳送' }).click();

    await expect(pageB.getByText(messageFromA)).toBeVisible({ timeout: 10_000 });

    // B 回覆，A 應該看到
    const messageFromB = 'Hello from User B';
    await pageB.getByPlaceholder('輸入訊息...').fill(messageFromB);
    await pageB.getByRole('button', { name: '傳送' }).click();

    await expect(pageA.getByText(messageFromB)).toBeVisible({ timeout: 10_000 });

    await contextA.close();
    await contextB.close();
  });
});
