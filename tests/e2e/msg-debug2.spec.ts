import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test('訊息 state debug — inject React state probe', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();

  // Inject probe BEFORE page loads
  await pageA.addInitScript(() => {
    // Hook into React setState to detect calls
    (window as any).__msgDebug = { addMessageCalls: 0, setMessagesCalls: 0, lastMessages: [] };
  });

  const logsA: string[] = [];
  pageA.on('console', msg => logsA.push(`[${msg.type()}] ${msg.text()}`));

  await pageA.goto(`${BASE}/dashboard`);
  await expect(pageA.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });

  // Build room
  await pageA.click('button:has-text("建立新房間")');
  await pageA.waitForTimeout(300);
  await pageA.click('button:has-text("建立房間")');
  await expect(pageA).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  const roomId = pageA.url().split('/waiting/')[1]!;

  // Bob joins
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE}/dashboard`);
  await expect(pageB.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });
  await pageB.goto(`${BASE}/chat/${roomId}`);

  await expect(pageA).toHaveURL(/\/chat\//, { timeout: 15_000 });
  await pageA.waitForTimeout(5000);

  // Try sending via Firestore fallback path by setting connectionState
  // First: check what messages React has
  const msgsInReact = await pageA.evaluate(() => {
    // Try to find React Fiber
    const chatArea = document.querySelector('.chat-messages');
    const key = Object.keys(chatArea || {}).find(k => k.startsWith('__reactFiber$'));
    if (!key || !chatArea) return { error: 'no fiber', childCount: chatArea?.children.length };

    let fiber = (chatArea as any)[key];
    // Walk up to find component with messages state
    while (fiber) {
      const state = fiber.memoizedState;
      if (state && state.memoizedState && Array.isArray(state.memoizedState)) {
        return { messages: state.memoizedState.length, fiberTag: fiber.tag };
      }
      fiber = fiber.return;
    }
    return { error: 'no messages state found', childCount: chatArea?.children.length };
  });
  console.log('React fiber messages:', JSON.stringify(msgsInReact));

  // Send via the input
  const input = pageA.locator('textarea').first();
  await input.fill('PROBE-MSG');
  await pageA.keyboard.press('Enter');
  await pageA.waitForTimeout(3000);

  // Check DOM
  const dom = await pageA.evaluate(() => {
    const area = document.querySelector('.chat-messages');
    if (!area) return { error: 'no .chat-messages' };
    return {
      innerHTML: area.innerHTML.slice(0, 500),
      childCount: area.children.length,
      children: Array.from(area.children).map(c => ({
        tag: c.tagName,
        className: c.className,
        text: c.textContent?.slice(0, 100),
      })),
    };
  });
  console.log('DOM after send:', JSON.stringify(dom, null, 2));

  // Check if the fallback subscription picked it up
  const firestoreLogs = logsA.filter(l => l.includes('Firestore') || l.includes('fallback') || l.includes('subscribeToFirestore'));
  console.log('\nFirestore-related logs:');
  firestoreLogs.forEach(l => console.log(l));

  await ctxA.close();
  await ctxB.close();
});
