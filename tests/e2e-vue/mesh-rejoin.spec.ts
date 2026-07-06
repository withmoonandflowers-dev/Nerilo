/**
 * ADR-0023 P1 驗收：mesh 房（3 人，gossip+對帳管線）成員離開畫面再進，
 * 訊息照常互通、各恰好一次。
 *
 * P1 修的根源：seq/複本原本是記憶體 → 重進後 seq 歸零，新訊息與對方複本
 * 舊 seq 碰撞被靜默當重複丟棄。持久化後 seq 續增、複本重生。
 * （2 人 star 房的同場景屬 P2「統一管線」，另行驗收。）
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  sendMessage,
  uniqueMessage,
  expectExactlyOnce,
  teardown,
} from './_helpers/users';

async function expectMeshReady(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
  await expect(page.locator('.chat__banner--info')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 60_000 });
}

test.describe('ADR-0023 P1：mesh 房重進', () => {
  test('B 離開再進後：能收到新訊息、自己發的也各恰好一次（seq 不碰撞）', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);
      await expectMeshReady(alice.page);
      await expectMeshReady(bob.page);
      await expectMeshReady(carol.page);

      // 重進前 B 先發過一則（讓對方複本存有 B 的 seq —— 碰撞場景的前置）
      const b1 = uniqueMessage('b-before');
      await sendMessage(bob.page, b1);
      await expectExactlyOnce(alice.page, b1);

      // B 離開畫面（返回 dashboard，非退出）再重進
      await bob.page.getByRole('button', { name: '離開房間' }).click();
      await expect(bob.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      await bob.page.locator('.room-row').first().click();
      await expectMeshReady(bob.page);

      // 收方向：A 發 → 重進的 B 收到
      const a1 = uniqueMessage('a-after');
      await sendMessage(alice.page, a1);
      await expectExactlyOnce(bob.page, a1, 30_000);

      // 發方向（碰撞核心）：B 重進後發 → A/C 各恰好一次
      // （P1 前這裡 B 的 seq 歸零=1，與 A/C 複本中 b-before 的 seq 碰撞被丟）
      const b2 = uniqueMessage('b-after');
      await sendMessage(bob.page, b2);
      await expectExactlyOnce(alice.page, b2, 30_000);
      await expectExactlyOnce(carol.page, b2, 30_000);
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
