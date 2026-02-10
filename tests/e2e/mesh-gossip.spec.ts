import { test, expect } from '@playwright/test';

test.describe('P2P 小網狀架構（Gossip）', () => {
  test('3 人可以建立小網狀連線並透過 gossip 傳訊', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

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
    pageC.on('console', (msg) => {
      if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warning') {
        console.log('[C]', msg.type(), msg.text());
      }
    });

    // A 建立房間
    await pageA.goto('/dashboard');
    await expect(pageA.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageA.getByRole('button', { name: '+ 建立新房間' }).click();
    await pageA.getByRole('button', { name: '建立房間' }).click();

    // A 應該在等待頁面
    await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const roomUrl = pageA.url().replace('/waiting/', '/chat/');

    // B 加入房間
    await pageB.goto('/dashboard');
    await expect(pageB.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageB.goto(roomUrl);

    // C 加入房間
    await pageC.goto('/dashboard');
    await expect(pageC.locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pageC.goto(roomUrl);

    // 等待所有用戶都進入聊天頁面
    await expect(pageA).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageB).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
    await expect(pageC).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

    // 等待連線建立（小網狀架構需要更多時間）
    await expect(pageA.getByText('已連線')).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByText('已連線')).toBeVisible({ timeout: 60_000 });
    await expect(pageC.getByText('已連線')).toBeVisible({ timeout: 60_000 });

    // A 發送訊息，B 和 C 都應該看到
    const messageFromA = 'Hello from User A (Gossip)';
    await pageA.getByPlaceholder('輸入訊息...').fill(messageFromA);
    await pageA.getByRole('button', { name: '傳送' }).click();

    await expect(pageB.getByText(messageFromA)).toBeVisible({ timeout: 15_000 });
    await expect(pageC.getByText(messageFromA)).toBeVisible({ timeout: 15_000 });

    // B 發送訊息，A 和 C 都應該看到
    const messageFromB = 'Hello from User B (Gossip)';
    await pageB.getByPlaceholder('輸入訊息...').fill(messageFromB);
    await pageB.getByRole('button', { name: '傳送' }).click();

    await expect(pageA.getByText(messageFromB)).toBeVisible({ timeout: 15_000 });
    await expect(pageC.getByText(messageFromB)).toBeVisible({ timeout: 15_000 });

    // C 發送訊息，A 和 B 都應該看到
    const messageFromC = 'Hello from User C (Gossip)';
    await pageC.getByPlaceholder('輸入訊息...').fill(messageFromC);
    await pageC.getByRole('button', { name: '傳送' }).click();

    await expect(pageA.getByText(messageFromC)).toBeVisible({ timeout: 15_000 });
    await expect(pageB.getByText(messageFromC)).toBeVisible({ timeout: 15_000 });

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });

  test('5 人可以建立小網狀連線並透過 gossip 傳訊', async ({ browser }) => {
    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
    ]);

    const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));

    // 設置 console 監聽
    pages.forEach((page, index) => {
      page.on('console', (msg) => {
        if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warning') {
          console.log(`[User${index + 1}]`, msg.type(), msg.text());
        }
      });
    });

    // User1 建立房間
    await pages[0].goto('/dashboard');
    await expect(pages[0].locator('.role-badge')).toBeVisible({ timeout: 15_000 });
    await pages[0].getByRole('button', { name: '+ 建立新房間' }).click();
    await pages[0].getByRole('button', { name: '建立房間' }).click();

    await expect(pages[0]).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
    const roomUrl = pages[0].url().replace('/waiting/', '/chat/');

    // 其他用戶加入
    for (let i = 1; i < pages.length; i++) {
      await pages[i].goto('/dashboard');
      await expect(pages[i].locator('.role-badge')).toBeVisible({ timeout: 15_000 });
      await pages[i].goto(roomUrl);
    }

    // 等待所有用戶都進入聊天頁面
    for (const page of pages) {
      await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
    }

    // 等待連線建立（5 人需要更多時間）
    for (const page of pages) {
      await expect(page.getByText('已連線')).toBeVisible({ timeout: 90_000 });
    }

    // User1 發送訊息，其他用戶都應該看到
    const messageFromUser1 = 'Hello from User 1 (5 users Gossip)';
    await pages[0].getByPlaceholder('輸入訊息...').fill(messageFromUser1);
    await pages[0].getByRole('button', { name: '傳送' }).click();

    for (let i = 1; i < pages.length; i++) {
      await expect(pages[i].getByText(messageFromUser1)).toBeVisible({ timeout: 20_000 });
    }

    // User3 發送訊息，其他用戶都應該看到
    const messageFromUser3 = 'Hello from User 3 (5 users Gossip)';
    await pages[2].getByPlaceholder('輸入訊息...').fill(messageFromUser3);
    await pages[2].getByRole('button', { name: '傳送' }).click();

    for (let i = 0; i < pages.length; i++) {
      if (i !== 2) {
        await expect(pages[i].getByText(messageFromUser3)).toBeVisible({ timeout: 20_000 });
      }
    }

    // 清理
    await Promise.all(contexts.map(ctx => ctx.close()));
  });
});
