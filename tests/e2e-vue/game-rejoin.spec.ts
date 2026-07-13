/**
 * 回報：離開房間再進去，遊戲無法玩。重現：開遊戲對戰 → B 離開回 dashboard → B 重進 → 再開遊戲 →
 * B 應仍是玩家（非觀戰）且能落子、A 看得到。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, createRoom, joinRoom, expectChatReady, teardown } from './_helpers/users';

const cell = (page: Page, i: number) => page.getByTestId(`ttt-cell-${i}`);

test.describe('Vue 版遊戲重進', () => {
  test('B 離開再進房後，遊戲仍可玩', async ({ browser }) => {
    test.setTimeout(200_000);
    const alice = await setupUser(browser); // 房主 = X
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 首次開遊戲對戰確認活著
      await alice.page.getByRole('button', { name: '開啟遊戲' }).click();
      await bob.page.getByRole('button', { name: '開啟遊戲' }).click();
      await expect(bob.page.getByTestId('ttt-status')).toHaveText('等待對方（X）', { timeout: 20_000 });
      await cell(alice.page, 0).click();
      await expect(cell(bob.page, 0)).toHaveText('X', { timeout: 10_000 });

      // B 離開回 dashboard（非退出）
      await bob.page.getByRole('button', { name: '離開房間' }).click();
      await expect(bob.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      await bob.page.locator('.room-row').first().click();
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
      await expectChatReady(bob.page);

      // B 重進後再開遊戲：應是玩家（O），不是觀戰；且能落子、A 看得到
      await bob.page.getByRole('button', { name: '開啟遊戲' }).click();
      await expect(bob.page.getByTestId('ttt-status')).not.toContainText('觀戰', { timeout: 20_000 });
      // 盤面同步：B 應看到 A 先前下的 X
      await expect(cell(bob.page, 0)).toHaveText('X', { timeout: 15_000 });
      // B 落子（O）→ A 看得到
      await cell(bob.page, 4).click();
      await expect(cell(alice.page, 4)).toHaveText('O', { timeout: 15_000 });
    } finally {
      await teardown(alice, bob);
    }
  });

  test('房主離開再進房後，遊戲仍可玩（房主=X）', async ({ browser }) => {
    test.setTimeout(200_000);
    const alice = await setupUser(browser); // 房主 = X
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      await alice.page.getByRole('button', { name: '開啟遊戲' }).click();
      await bob.page.getByRole('button', { name: '開啟遊戲' }).click();
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）', { timeout: 20_000 });

      // 房主 A 離開回 dashboard，再進同房
      await alice.page.getByRole('button', { name: '離開房間' }).click();
      await expect(alice.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
      await alice.page.locator('.room-row').first().click();
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
      await expectChatReady(alice.page);

      // 重進後 A 再開遊戲：仍是房主（X），能落子、B 看得到
      await alice.page.getByRole('button', { name: '開啟遊戲' }).click();
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）', { timeout: 20_000 });
      await cell(alice.page, 0).click();
      await expect(cell(bob.page, 0)).toHaveText('X', { timeout: 15_000 });
    } finally {
      await teardown(alice, bob);
    }
  });
});
