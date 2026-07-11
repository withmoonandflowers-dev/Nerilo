/**
 * web-vue 遊戲座位（3 人 mesh 房）：2 人對戰、第 3 人觀戰。
 * 觀戰者看得到雙方落子、但不能下（座位模型 seats.ts）。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, createRoom, joinRoom, expectChatReady, teardown } from './_helpers/users';

const cell = (page: Page, i: number) => page.getByTestId(`ttt-cell-${i}`);

test.describe('Vue 版遊戲座位（3 人房）', () => {
  test('房主+入座者對戰，第三人觀戰：看得到落子、不能下', async ({ browser }) => {
    test.setTimeout(200_000);
    const alice = await setupUser(browser); // 房主 = 座 0（X）
    const bob = await setupUser(browser);
    const carol = await setupUser(browser); // 觀戰者
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);
      await expectChatReady(carol.page);

      // 三方開遊戲（井字棋預設）
      for (const p of [alice.page, bob.page, carol.page]) {
        await p.getByRole('button', { name: '開啟遊戲' }).click();
      }

      // bob 入座當第二位（若已自動入座則跳過）；carol 不入座 → 恆觀戰
      const bobSit = bob.page.getByTestId('seat-sit');
      if (await bobSit.isVisible().catch(() => false)) await bobSit.click();

      // 角色：alice=X（房主）、bob=O（入座）、carol=觀戰
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）', { timeout: 20_000 });
      await expect(bob.page.getByTestId('ttt-status')).toHaveText('等待對方（X）', { timeout: 20_000 });
      await expect(carol.page.getByTestId('ttt-status')).toContainText('觀戰中', { timeout: 20_000 });

      // alice（X）下一子 → bob 與 carol 都看得到
      await cell(alice.page, 0).click();
      await expect(cell(bob.page, 0)).toHaveText('X', { timeout: 10_000 });
      await expect(cell(carol.page, 0)).toHaveText('X', { timeout: 10_000 });

      // carol 是觀戰者：格子不可互動（disabled）
      await expect(cell(carol.page, 1)).toBeDisabled();

      // bob（O）回一子 → alice 與 carol 都看得到，且 carol 仍觀戰
      await cell(bob.page, 4).click();
      await expect(cell(alice.page, 4)).toHaveText('O', { timeout: 10_000 });
      await expect(cell(carol.page, 4)).toHaveText('O', { timeout: 10_000 });
      await expect(carol.page.getByTestId('ttt-status')).toContainText('觀戰中');
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
