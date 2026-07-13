/**
 * web-vue 訊息表情 reactions：對某訊息加/移除表情，跨端可見（走 mesh 'reaction' 通道，E2EE）。
 */
import { test, expect } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  uniqueMessage,
  expectExactlyOnce,
  teardown,
} from './_helpers/users';

test.describe('Vue 版訊息表情', () => {
  test('B 對 A 的訊息加 👍 → A 端看到計數；再點一次移除', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // A 送一則，兩端各恰好一次
      const text = uniqueMessage('react');
      await sendMessage(alice.page, text);
      await expectExactlyOnce(alice.page, text);
      await expectExactlyOnce(bob.page, text);

      // B 對該訊息加 👍（hover 顯示按鈕 → 開選單 → 點 👍）
      const bobRow = bob.page.locator('.msg-row', { hasText: text });
      await bobRow.hover();
      await bobRow.locator('[data-testid^="react-btn-"]').click();
      await bob.page.locator('.react-picker__item', { hasText: '👍' }).click();

      // A 端該訊息底下出現 👍 1
      const aliceChip = alice.page
        .locator('.msg-row', { hasText: text })
        .locator('.react-chip', { hasText: '👍' });
      await expect(aliceChip).toBeVisible({ timeout: 15_000 });
      await expect(aliceChip.locator('.react-chip__n')).toHaveText('1');

      // B 再點自己的 👍 chip → 移除；A 端 chip 消失
      await bob.page.locator('.msg-row', { hasText: text }).locator('.react-chip', { hasText: '👍' }).click();
      await expect(aliceChip).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await teardown(alice, bob);
    }
  });
});
