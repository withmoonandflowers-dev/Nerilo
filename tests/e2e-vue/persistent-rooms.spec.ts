/**
 * 持久聊天室（2026-07-05 產品決策）：
 * - 跳出畫面 ≠ 離開：回 dashboard 後聊天室仍在列表；
 * - 未讀：對方發訊 → 列表亮未讀點；打開後熄滅；
 * - 釘選：置頂並顯示 📌；
 * - 刪除：軟刪除只從自己列表消失，對方仍保留。
 */
import { test, expect } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  uniqueMessage,
  teardown,
} from './_helpers/users';

test.describe('持久聊天室：跳出不離開、未讀、釘選、刪除', () => {
  test('完整生命週期', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    bob.page.on('dialog', (d) => d.accept()); // 退出/刪除的 confirm 一律接受
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 先互通一則，確認房間活著
      const hello = uniqueMessage('persist');
      await sendMessage(alice.page, hello);
      await expect(bob.page.locator('.bubble').filter({ hasText: hello })).toBeVisible({
        timeout: 15_000,
      });

      // ── 跳出畫面 ≠ 離開：B 回 dashboard，聊天室仍在列表 ──
      await bob.page.getByRole('button', { name: '離開房間' }).click();
      await expect(bob.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      const bobRow = bob.page.locator('.room-row');
      await expect(bobRow).toHaveCount(1, { timeout: 15_000 });

      // ── 未讀：A 再發訊（bump lastActiveAt）→ B 列表亮未讀點 ──
      const unreadMsg = uniqueMessage('unread');
      await sendMessage(alice.page, unreadMsg);
      await expect(bob.page.locator('.room-row__dot')).toBeVisible({ timeout: 30_000 });

      // 打開後未讀熄滅
      await bobRow.click();
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
      await bob.page.getByRole('button', { name: '離開房間' }).click();
      await expect(bob.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      await expect(bob.page.locator('.room-row__dot')).toHaveCount(0, { timeout: 10_000 });

      // ── 釘選：📌 顯示（只有一房；menu 內定位避免與潛在多房撞名）──
      await expect(bob.page.locator('.room-row')).toHaveCount(1);
      await bob.page.locator('.room-row__more').first().click();
      await bob.page.locator('.room-menu').getByText('釘選置頂').click();
      await expect(bob.page.locator('.room-row__pin')).toBeVisible({ timeout: 10_000 });

      // ── 刪除：B 軟刪除 → B 列表消失；A 回列表仍保留 ──
      await bob.page.locator('.room-row__more').first().click();
      await bob.page.locator('.room-menu').getByText('刪除聊天室').click();
      await expect(bob.page.locator('.room-row')).toHaveCount(0, { timeout: 15_000 });

      await alice.page.getByRole('button', { name: '離開房間' }).click();
      await expect(alice.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      await expect(alice.page.locator('.room-row')).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await teardown(alice, bob);
    }
  });
});
