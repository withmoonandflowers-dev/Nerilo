import { test, expect } from '@playwright/test';

test('兩個 guest 可以建立房間並互相傳訊息', async ({ browser }) => {
  // 建立兩個獨立的瀏覽器 context，模擬兩個不同的遊客
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // 將瀏覽器 console log 帶到測試輸出，方便偵錯 P2P 狀態
  pageA.on('console', (msg) => {
    // 只輸出一般 log，避免過多雜訊
    if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log('[A]', msg.type(), msg.text());
    }
  });
  pageB.on('console', (msg) => {
    if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log('[B]', msg.type(), msg.text());
    }
  });

  // 遊客 A 進入 Dashboard 並建立房間
  await pageA.goto('/dashboard');

  // 等待自動匿名登入完成（出現 guest badge 或 role-badge）
  await expect(pageA.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
  await expect(pageA.locator('.role-badge')).toContainText('guest', { timeout: 5_000 });

  await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
  await pageA.getByRole('button', { name: '建立房間' }).click();

  // A 會被導到 /waiting/:roomId（等待頁面），記住完整 URL，給 B 使用
  await expect(pageA).toHaveURL(/\/waiting\/.+/);
  const roomUrl = pageA.url().replace('/waiting/', '/chat/');
  
  // 確認 A 在等待頁面
  await expect(pageA.getByText('等待連線')).toBeVisible();

  // 遊客 B 直接打開同一個 room URL（模擬從朋友那裡拿到連結）
  await pageB.goto(roomUrl);
  
  // B 加入後，房間狀態會自動從 waiting 轉為 open，雙方都會被導到聊天頁面
  await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
  await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });

  // 等待雙方連線狀態為「已連線」
  await expect(pageA.getByText('已連線')).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByText('已連線')).toBeVisible({ timeout: 30_000 });

  // A 傳送訊息，B 應該看到
  const messageFromA = 'hello from A (e2e)';
  await pageA.getByPlaceholder('輸入訊息...').fill(messageFromA);
  await pageA.getByRole('button', { name: '傳送' }).click();

  await expect(pageB.getByText(messageFromA)).toBeVisible({ timeout: 10_000 });

  // B 回覆，A 應該看到
  const messageFromB = 'hello from B (e2e)';
  await pageB.getByPlaceholder('輸入訊息...').fill(messageFromB);
  await pageB.getByRole('button', { name: '傳送' }).click();

  await expect(pageA.getByText(messageFromB)).toBeVisible({ timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

