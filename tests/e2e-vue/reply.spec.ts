/**
 * web-vue 訊息回覆：B 回覆 A 的某則訊息，回覆 bubble 帶被引用訊息預覽，跨端可見。
 * 回覆對象嵌在密文內容中（messageContent.ts），隨訊息一起 E2EE。
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

test.describe('Vue 版訊息回覆', () => {
  test('B 回覆 A 的訊息 → 兩端都看到引用預覽', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // A 送原訊息
      const original = uniqueMessage('orig');
      await sendMessage(alice.page, original);
      await expectExactlyOnce(bob.page, original);

      // B 對原訊息按回覆 → 回覆列出現
      const bobRow = bob.page.locator('.msg-row', { hasText: original });
      await bobRow.hover();
      await bobRow.locator('[data-testid^="reply-btn-"]').click();
      await expect(bob.page.getByTestId('reply-bar')).toBeVisible();

      // B 送出回覆
      const reply = uniqueMessage('reply');
      await bob.page.getByLabel('訊息輸入框').fill(reply);
      await bob.page.getByRole('button', { name: '傳送' }).click();

      // A 端看到 B 的回覆 bubble，且帶原訊息的引用預覽
      const aliceReplyRow = alice.page.locator('.msg-row', { hasText: reply });
      await expect(aliceReplyRow).toBeVisible({ timeout: 15_000 });
      const quote = aliceReplyRow.locator('.bubble-quote');
      await expect(quote).toBeVisible();
      await expect(quote).toContainText(original);

      // 純文字本體不含編碼標記（golden-path 相容）
      await expect(aliceReplyRow.locator('.bubble')).toContainText(reply);
      await expect(aliceReplyRow.locator('.bubble')).not.toContainText('nrl-reply');
    } finally {
      await teardown(alice, bob);
    }
  });
});
