/**
 * Vue P1 資料路徑 parity：Unicode、長訊息、burst 順序與整頁 reload 復原。
 * 一次建立連線後連續驗四種風險，避免為每個 payload 重建昂貴 WebRTC fixture。
 */
import { test, expect } from '@playwright/test';
import {
  setupUser, createRoom, joinRoom, expectChatReady, sendMessage,
  uniqueMessage, expectExactlyOnce, teardown,
} from './_helpers/users';

test.describe('Vue P1 訊息與重載 parity', () => {
  test('Unicode、5KB、10 則 burst 與 reload 後歷史皆不重不漏 @vue-stable', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const unicode = uniqueMessage('👋 你好 🌏 émoji éclair');
      await sendMessage(alice.page, unicode);
      await expectExactlyOnce(bob.page, unicode);

      const longPrefix = uniqueMessage('long');
      const longMessage = `${longPrefix} ${'界'.repeat(5_000)}`;
      await sendMessage(alice.page, longMessage);
      await expectExactlyOnce(bob.page, longPrefix, 30_000);

      const burst = Array.from({ length: 10 }, (_, i) => uniqueMessage(`burst-${String(i).padStart(2, '0')}`));
      // 前兩則不應吃掉 burst 的 10 msg/s 配額；跨到新的 rate-limit 視窗再送滿邊界值。
      await alice.page.waitForTimeout(1_100);
      for (const message of burst) await sendMessage(alice.page, message);
      for (const message of burst) await expectExactlyOnce(bob.page, message, 30_000);
      const visibleOrder = await bob.page.locator('.bubble').evaluateAll((nodes, needles) => {
        const texts = nodes.map((n) => n.textContent ?? '');
        return (needles as string[]).map((needle) => texts.findIndex((text) => text.includes(needle)));
      }, burst);
      expect(visibleOrder).toEqual([...visibleOrder].sort((a, b) => a - b));
      expect(visibleOrder.every((index) => index >= 0)).toBe(true);

      // 真整頁 reload：記憶體清空，歷史必須由 IndexedDB replica hydrate 回來。
      await bob.page.reload();
      await expect(bob.page).toHaveURL(new RegExp(`/chat/${roomId}`), { timeout: 20_000 });
      await expectExactlyOnce(bob.page, unicode, 20_000);
      await expectExactlyOnce(bob.page, longPrefix, 20_000);
      for (const message of burst) await expectExactlyOnce(bob.page, message, 20_000);
    } finally {
      await teardown(alice, bob);
    }
  });
});
