import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test('訊息渲染 debug — 直接檢查 React 渲染結果', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();

  await pageA.goto(`${BASE}/dashboard`);
  await expect(pageA.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });

  await pageA.click('button:has-text("建立新房間")');
  await pageA.waitForTimeout(300);
  await pageA.click('button:has-text("建立房間")');
  await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  const roomId = pageA.url().split('/waiting/')[1]!;

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE}/dashboard`);
  await expect(pageB.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });
  await pageB.goto(`${BASE}/chat/${roomId}`);

  await expect(pageA).toHaveURL(/\/chat\//, { timeout: 15_000 });
  await pageA.waitForTimeout(5000);

  // Send
  const input = pageA.locator('textarea').first();
  await input.fill('RENDER-TEST');
  await pageA.keyboard.press('Enter');
  await pageA.waitForTimeout(3000);

  // Check ALL DOM under .chat-messages with every possible selector
  const result = await pageA.evaluate(() => {
    const area = document.querySelector('.chat-messages');
    return {
      fullHTML: area?.innerHTML ?? 'NOT_FOUND',
      allDivs: document.querySelectorAll('.chat-messages > div').length,
      allMessages: document.querySelectorAll('.message').length,
      allP: document.querySelectorAll('.chat-messages p').length,
      bodyText: document.body.innerText.includes('RENDER-TEST'),
      // Check if there are any elements with display:none
      hiddenChildren: Array.from(area?.children ?? []).map(c => {
        const style = window.getComputedStyle(c);
        return { tag: c.tagName, display: style.display, visibility: style.visibility, height: style.height, className: c.className };
      }),
    };
  });

  console.log('Result:', JSON.stringify(result, null, 2));

  // Also dump the full page HTML for .chat-page
  const chatPageHTML = await pageA.evaluate(() => {
    const el = document.querySelector('.chat-page');
    return el?.innerHTML?.slice(0, 2000) ?? 'NOT_FOUND';
  });
  console.log('Chat page HTML (first 2000):', chatPageHTML);

  await ctxA.close();
  await ctxB.close();
});
