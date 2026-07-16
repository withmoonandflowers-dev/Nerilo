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
  // ADR-0023 P2-③：star 特例退役，2 人房改走 gossip 複寫日誌後，本 bug 整類消滅。
  // 舊根因是「連線中心」世界觀（訊息綁在那一條 P2P 連線上，連線死＝訊息丟，star
  // 無自動重連）。改資料中心後：重進＝cold→syncing→live，B 重連 mesh、缺的訊息
  // 由留房者 A 經 anti-entropy 補齊（複本落地 IndexedDB, P1；內容 E2EE, keyx P2-②c）。
  // 因此無需 star 的「連線復活術」（perfect-negotiation）——那正是前兩次修復失敗處。
  test('B 離開回 dashboard 再進房，仍收得到 A 之後發的訊息 @vue-stable', async ({ browser }) => {
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
