/**
 * web-vue 黃金路徑：註冊 → 建房 → 加入 → P2P 連線 → 訊息雙向各恰好一次。
 */
import { test } from '@playwright/test';
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

test.describe('Vue 版黃金路徑', () => {
  test('2 人 mesh：雙向訊息、寄收兩端各恰好一次 @vue-stable', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const fromA = uniqueMessage('vueA');
      await sendMessage(alice.page, fromA);
      await expectExactlyOnce(alice.page, fromA);
      await expectExactlyOnce(bob.page, fromA);

      const fromB = uniqueMessage('vueB');
      await sendMessage(bob.page, fromB);
      await expectExactlyOnce(bob.page, fromB);
      await expectExactlyOnce(alice.page, fromB);
    } finally {
      await teardown(alice, bob);
    }
  });
});
