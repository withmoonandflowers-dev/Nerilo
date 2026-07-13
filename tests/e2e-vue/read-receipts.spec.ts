/**
 * web-vue 已讀人數：只在自己訊息下顯示；對方讀過即回報（走 mesh 'read' 水位通道，E2EE）。
 * 2 人房 → 「已讀」；3 人房 → 「已讀 N」。水位單調，多人讀到即累加。
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

test.describe('Vue 版已讀人數', () => {
  test('2 人房：對方讀到後，我的訊息顯示「已讀」', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const text = uniqueMessage('read2');
      await sendMessage(alice.page, text);
      await expectExactlyOnce(alice.page, text);
      await expectExactlyOnce(bob.page, text); // bob 收到（在底部）→ 自動回報已讀水位

      // alice 端該（最後一則自己）訊息底下狀態變「已讀」
      const status = alice.page.locator('.msg-status').last();
      await expect(status).toHaveText('已讀', { timeout: 20_000 });
    } finally {
      await teardown(alice, bob);
    }
  });

  test('3 人房：兩位讀到 → 顯示「已讀 2」', async ({ browser }) => {
    test.setTimeout(200_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);
      await expectChatReady(carol.page);

      const text = uniqueMessage('read3');
      await sendMessage(alice.page, text);
      await expectExactlyOnce(alice.page, text);
      await expectExactlyOnce(bob.page, text);
      await expectExactlyOnce(carol.page, text);

      // bob + carol 都在底部收到 → 各自回報水位 → alice 看到「已讀 2」
      const status = alice.page.locator('.msg-status').last();
      await expect(status).toHaveText('已讀 2', { timeout: 30_000 });
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
