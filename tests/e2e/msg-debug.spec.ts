import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test('訊息送出 debug', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();

  // 收集 console.log
  const logsA: string[] = [];
  pageA.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warn') {
      logsA.push(`[${msg.type()}] ${msg.text()}`);
    }
  });

  await pageA.goto(`${BASE}/dashboard`);
  await expect(pageA.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });

  // 建房
  await pageA.click('button:has-text("建立新房間")');
  await pageA.waitForTimeout(300);
  await pageA.click('button:has-text("建立房間")');
  await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  const roomId = pageA.url().split('/waiting/')[1]!;

  // Bob 加入
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE}/dashboard`);
  await expect(pageB.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });
  await pageB.goto(`${BASE}/chat/${roomId}`);

  // 等 Alice 也跳到 chat
  await expect(pageA).toHaveURL(/\/chat\//, { timeout: 15_000 });

  // 等連線建立
  await pageA.waitForTimeout(5000);

  // 查連線狀態
  const statusA = await pageA.textContent('.connection-status');
  console.log('Alice connection status:', statusA);

  // 查 React 狀態
  const msgCountBefore = await pageA.evaluate(() => {
    const chatMsgs = document.querySelector('.chat-messages');
    return chatMsgs?.children.length ?? -1;
  });
  console.log('Message DOM children before send:', msgCountBefore);

  // 送訊息
  const input = pageA.locator('textarea').first();
  await input.fill('test-message-123');
  await pageA.keyboard.press('Enter');
  await pageA.waitForTimeout(3000);

  // 查 DOM
  const msgCountAfter = await pageA.evaluate(() => {
    const chatMsgs = document.querySelector('.chat-messages');
    return chatMsgs?.children.length ?? -1;
  });
  console.log('Message DOM children after send:', msgCountAfter);

  // 查 body
  const bodyText = await pageA.textContent('.chat-messages');
  console.log('Chat messages area text:', JSON.stringify(bodyText?.trim().slice(0, 200)));

  // 取所有相關 logs
  const chatLogs = logsA.filter(l =>
    l.includes('ChatService') ||
    l.includes('ChatPage') ||
    l.includes('message') ||
    l.includes('addMessage') ||
    l.includes('listener')
  );
  console.log('\n=== Relevant logs ===');
  chatLogs.forEach(l => console.log(l));

  // 看有沒有 error
  const errors = logsA.filter(l => l.startsWith('[error]'));
  console.log('\n=== Errors ===');
  errors.slice(0, 20).forEach(l => console.log(l));

  await pageA.screenshot({ path: 'test-results/msg-debug.png' });

  await ctxA.close();
  await ctxB.close();
});
