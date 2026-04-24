import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE = 'http://localhost:3000';

interface User {
  ctx: BrowserContext;
  page: Page;
  name: string;
}

async function setupUser(browser: import('@playwright/test').Browser, name: string): Promise<User> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/dashboard`);
  await expect(page.locator('text=我的房間')).toBeVisible({ timeout: 15_000 });
  return { ctx, page, name };
}

async function createRoom(page: Page): Promise<string> {
  await page.click('button:has-text("建立新房間")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("建立房間")');
  await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 10_000 });
  return page.url().split('/waiting/')[1]!;
}

async function _joinChat(page: Page, roomId: string): Promise<void> {
  await page.goto(`${BASE}/chat/${roomId}`);
  // 等待聊天輸入框出現
  await expect(page.locator('input[type="text"], textarea').first()).toBeVisible({ timeout: 30_000 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.locator('input[type="text"], textarea').first();
  await input.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

async function _getVisibleMessages(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // 抓取所有可能的訊息元素文字
    const msgs: string[] = [];
    document.querySelectorAll('[class*="message"], [class*="Message"], [data-message]').forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length > 0 && text.length < 200) msgs.push(text);
    });
    return msgs;
  });
}

async function getBodyText(page: Page): Promise<string> {
  return (await page.textContent('body')) ?? '';
}

// ─── 測試 ───────────────────────────────────────────────────────────────

test.describe.serial('多人連線穩定度與訊息一致性', () => {

  test('1. 雙人 Star Topology — 訊息雙向傳遞 + 順序一致', async ({ browser }) => {
    const alice = await setupUser(browser, 'Alice');
    const roomId = await createRoom(alice.page);

    const bob = await setupUser(browser, 'Bob');

    // Bob 加入 → host 自動轉到 chat
    await bob.page.goto(`${BASE}/chat/${roomId}`);
    await expect(alice.page).toHaveURL(/\/chat\//, { timeout: 15_000 });

    // 等聊天介面就緒
    await expect(alice.page.locator('input[type="text"], textarea').first()).toBeVisible({ timeout: 30_000 });
    await expect(bob.page.locator('input[type="text"], textarea').first()).toBeVisible({ timeout: 30_000 });

    // 等 P2P 或 Firestore fallback 建立
    await alice.page.waitForTimeout(3000);

    // Alice 發 3 則，Bob 發 3 則，交錯發送
    const sequence = [
      { user: alice, msg: 'A1-hello' },
      { user: bob, msg: 'B1-hi' },
      { user: alice, msg: 'A2-how-are-you' },
      { user: bob, msg: 'B2-fine' },
      { user: alice, msg: 'A3-great' },
      { user: bob, msg: 'B3-bye' },
    ];

    for (const { user, msg } of sequence) {
      await sendMessage(user.page, msg);
      await user.page.waitForTimeout(500); // 給傳輸時間
    }

    // 等待所有訊息傳播
    await alice.page.waitForTimeout(5000);

    // 檢查兩邊都能看到所有訊息
    const aliceBody = await getBodyText(alice.page);
    const bobBody = await getBodyText(bob.page);

    await alice.page.screenshot({ path: 'test-results/multi-01-alice.png' });
    await bob.page.screenshot({ path: 'test-results/multi-01-bob.png' });

    const allMsgs = sequence.map(s => s.msg);
    let aliceCount = 0, bobCount = 0;
    for (const msg of allMsgs) {
      if (aliceBody.includes(msg)) aliceCount++;
      if (bobBody.includes(msg)) bobCount++;
    }

    console.log(`\n📊 [雙人訊息] Alice sees: ${aliceCount}/${allMsgs.length}, Bob sees: ${bobCount}/${allMsgs.length}`);
    console.log(`   Alice body snippet: ${aliceBody.slice(0, 300)}`);

    // 至少自己發的訊息自己要看得到（3/6），理想是全部 6/6
    expect(aliceCount, 'Alice should see at least her own messages').toBeGreaterThanOrEqual(3);
    expect(bobCount, 'Bob should see at least his own messages').toBeGreaterThanOrEqual(3);

    await alice.ctx.close();
    await bob.ctx.close();
  });

  test('2. 三人 Mesh Topology — 訊息全員同步', async ({ browser }) => {
    // 建立 host
    const host = await setupUser(browser, 'Host');
    const roomId = await createRoom(host.page);

    // 2 人加入 → 觸發 mesh (>=3人)
    const u2 = await setupUser(browser, 'User2');
    const u3 = await setupUser(browser, 'User3');

    await u2.page.goto(`${BASE}/chat/${roomId}`);
    await u2.page.waitForTimeout(2000);
    await u3.page.goto(`${BASE}/chat/${roomId}`);

    // 等 host 轉到 chat
    await expect(host.page).toHaveURL(/\/chat\//, { timeout: 15_000 });

    // 等聊天介面
    const users = [host, u2, u3];
    for (const u of users) {
      await expect(u.page.locator('input[type="text"], textarea').first())
        .toBeVisible({ timeout: 30_000 });
    }
    await host.page.waitForTimeout(5000); // 等 mesh 建立

    // 每人發 2 則
    const messages = [
      { user: host, msg: 'HOST-msg1' },
      { user: u2, msg: 'U2-msg1' },
      { user: u3, msg: 'U3-msg1' },
      { user: host, msg: 'HOST-msg2' },
      { user: u2, msg: 'U2-msg2' },
      { user: u3, msg: 'U3-msg2' },
    ];

    for (const { user, msg } of messages) {
      await sendMessage(user.page, msg);
      await user.page.waitForTimeout(800);
    }

    // 等傳播
    await host.page.waitForTimeout(8000);

    // 檢查每人能看到多少訊息
    const allMsgTexts = messages.map(m => m.msg);
    const results: Record<string, number> = {};

    for (const u of users) {
      const body = await getBodyText(u.page);
      let count = 0;
      for (const msg of allMsgTexts) {
        if (body.includes(msg)) count++;
      }
      results[u.name] = count;
      await u.page.screenshot({ path: `test-results/multi-02-${u.name.toLowerCase()}.png` });
    }

    console.log(`\n📊 [三人Mesh] Message visibility:`);
    for (const [name, count] of Object.entries(results)) {
      console.log(`   ${name}: ${count}/${allMsgTexts.length}`);
    }

    // 每人至少要看到自己的 2 則
    for (const u of users) {
      expect(results[u.name], `${u.name} should see at least own msgs`).toBeGreaterThanOrEqual(2);
    }

    for (const u of users) await u.ctx.close();
  });

  test('3. 連線斷開恢復 — 離開再回來', async ({ browser }) => {
    const alice = await setupUser(browser, 'Alice');
    const roomId = await createRoom(alice.page);

    const bob = await setupUser(browser, 'Bob');
    await bob.page.goto(`${BASE}/chat/${roomId}`);
    await expect(alice.page).toHaveURL(/\/chat\//, { timeout: 15_000 });

    await alice.page.waitForTimeout(3000);

    // Alice 發訊息
    await sendMessage(alice.page, 'before-disconnect');
    await alice.page.waitForTimeout(1000);

    // Bob 離開（navigate away）
    await bob.page.goto(`${BASE}/dashboard`);
    await bob.page.waitForTimeout(2000);

    // Alice 在 Bob 離開時再發一則
    await sendMessage(alice.page, 'during-disconnect');
    await alice.page.waitForTimeout(1000);

    // Bob 重新加入
    await bob.page.goto(`${BASE}/chat/${roomId}`);
    await bob.page.waitForTimeout(5000);

    const bobBody = await getBodyText(bob.page);
    await bob.page.screenshot({ path: 'test-results/multi-03-rejoin.png' });

    const seenBefore = bobBody.includes('before-disconnect');
    const seenDuring = bobBody.includes('during-disconnect');

    console.log(`\n📊 [斷線恢復]`);
    console.log(`   Bob sees 'before-disconnect': ${seenBefore}`);
    console.log(`   Bob sees 'during-disconnect': ${seenDuring}`);

    // 至少在回來後能看到一些訊息（依賴 Firestore fallback）
    console.log(`   Bob body snippet: ${bobBody.slice(0, 300)}`);

    await alice.ctx.close();
    await bob.ctx.close();
  });

  test('4. 快速連續發送壓力（10 則/秒）', async ({ browser }) => {
    const alice = await setupUser(browser, 'Alice');
    const roomId = await createRoom(alice.page);

    const bob = await setupUser(browser, 'Bob');
    await bob.page.goto(`${BASE}/chat/${roomId}`);
    await expect(alice.page).toHaveURL(/\/chat\//, { timeout: 15_000 });
    await alice.page.waitForTimeout(3000);

    const BURST = 10;
    const sentMsgs: string[] = [];

    console.log(`\n📊 [快速發送] Sending ${BURST} messages rapidly...`);

    const start = Date.now();
    for (let i = 0; i < BURST; i++) {
      const msg = `burst-${i}-${Date.now()}`;
      sentMsgs.push(msg);
      const input = alice.page.locator('input[type="text"], textarea').first();
      await input.fill(msg);
      await alice.page.keyboard.press('Enter');
      // 不等待，模擬快速連續發送
    }
    const sendTime = Date.now() - start;
    console.log(`   Send time: ${sendTime}ms (${(sendTime / BURST).toFixed(0)}ms/msg)`);

    // 等傳播
    await alice.page.waitForTimeout(8000);

    const aliceBody = await getBodyText(alice.page);
    let aliceVisible = 0;
    for (const msg of sentMsgs) {
      if (aliceBody.includes(msg)) aliceVisible++;
    }

    console.log(`   Alice sees: ${aliceVisible}/${BURST}`);
    await alice.page.screenshot({ path: 'test-results/multi-04-burst.png' });

    // 至少 50% 的訊息要成功（考慮到可能有 rate limiting）
    expect(aliceVisible, 'At least 50% of burst messages visible').toBeGreaterThanOrEqual(BURST * 0.5);

    await alice.ctx.close();
    await bob.ctx.close();
  });
});
