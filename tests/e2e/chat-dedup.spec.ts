/**
 * 聊天去重回歸 + 完整往返（@stable）
 *
 * 鎖住「寄件方訊息重複」的修復（messageId 貫穿樂觀顯示與服務自我 emit）：
 * 送出多則後，每則在寄件方與收件方畫面上都必須「恰好一個泡泡」。
 * 同時驗 E2EE 指示、雙向送達，並存截圖作為 QA 證據。
 */
import { test, expect } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  expectE2EEReady,
  sendMessage,
  expectMessageReceived,
  uniqueMessage,
  teardown,
} from './_helpers/users';

const EVIDENCE_DIR =
  '/private/tmp/claude-501/-Users-ti9ert0m6-forwork-rich/daecf539-1f20-4e48-801c-693247d32453/scratchpad';

test.describe('聊天去重 + 完整往返 @stable', () => {
  test('多則訊息在雙方畫面各恰好一次（無重複）+ E2EE + 雙向', async ({ browser }) => {
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);
      await expectE2EEReady(alice.page);
      await expectE2EEReady(bob.page);

      // A 連送 3 則
      const msgs = [uniqueMessage('A-1'), uniqueMessage('A-2'), uniqueMessage('A-3')];
      for (const m of msgs) {
        await sendMessage(alice.page, m);
        await expectMessageReceived(bob.page, m);
      }

      // 去重核心斷言：寄件方(A) 與 收件方(B) 每則都恰好 1 個泡泡
      for (const m of msgs) {
        await expect(
          alice.page.locator('.message-content').filter({ hasText: m }),
          `寄件方 A 的 "${m}" 應恰好一則（不重複）`,
        ).toHaveCount(1);
        await expect(
          bob.page.locator('.message-content').filter({ hasText: m }),
          `收件方 B 的 "${m}" 應恰好一則`,
        ).toHaveCount(1);
      }

      // B 回覆，A 收到且同樣不重複
      const reply = uniqueMessage('B-reply');
      await sendMessage(bob.page, reply);
      await expectMessageReceived(alice.page, reply);
      await expect(bob.page.locator('.message-content').filter({ hasText: reply })).toHaveCount(1);
      await expect(alice.page.locator('.message-content').filter({ hasText: reply })).toHaveCount(1);

      // QA 證據截圖
      await alice.page.screenshot({ path: `${EVIDENCE_DIR}/qa-chat-alice.png`, fullPage: true });
      await bob.page.screenshot({ path: `${EVIDENCE_DIR}/qa-chat-bob.png`, fullPage: true });
    } finally {
      await teardown(alice, bob);
    }
  });
});
