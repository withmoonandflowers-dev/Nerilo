/**
 * 重進聊天室（離開畫面 ≠ 退出）：B 返回 dashboard 再進同一房，
 * 應照常收發訊息（P2P 重連或至少 Firestore 備援）。使用者回報「離開再進就不能用」。
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

test.describe('Vue 版重進聊天室', () => {
  // fixme：重現「離開再進聊天室就收不到訊息」的已知 bug（2 人 star 房）。
  // 根因（Chrome + E2E 實測確認）：
  //  1. 留房者 A 沒偵測到對方離開，connectionState 停在 connected，繼續往已死的
  //     P2P DataChannel 送訊（黑洞），從不 fallback。
  //  2. 重進者 B 作為 answerer 死等 offer，star 無自動重連。
  //  3. star 房備援是 E2EE 密文，B 沒完成 P2P 金鑰交換就解不開 → 必須 P2P 真正重連。
  // 嘗試過 Vue 層看門狗自動重連，但雙方重新握手的 signaling session 對不上（在
  // P2PConnectionManager 深層）——需 perfect-negotiation + 重連 session 協調，屬
  // P2P 核心工程（且與 React 生產共用），另闢一輪謹慎處理。
  test.fixme('B 離開回 dashboard 再進房，仍收得到 A 之後發的訊息', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 首次互通確認活著
      const m1 = uniqueMessage('before');
      await sendMessage(alice.page, m1);
      await expectExactlyOnce(bob.page, m1);

      // B 離開畫面（返回 dashboard，非退出）
      await bob.page.getByRole('button', { name: '離開房間' }).click();
      await expect(bob.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      await expect(bob.page.locator('.room-row')).toHaveCount(1, { timeout: 15_000 });

      // B 重進同一房（點列表）——不卡 P2P「已連線」，只要能收發訊息就算可用
      await bob.page.locator('.room-row').first().click();
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });

      // A 發新訊息 → B 必須收到（P2P 重連 或 Firestore 備援任一）
      const m2 = uniqueMessage('after-rejoin');
      await sendMessage(alice.page, m2);
      await expectExactlyOnce(bob.page, m2, 30_000);

      // 反向也通：B 發，A 收
      const m3 = uniqueMessage('bob-after');
      await sendMessage(bob.page, m3);
      await expectExactlyOnce(alice.page, m3, 30_000);
    } finally {
      await teardown(alice, bob);
    }
  });
});
