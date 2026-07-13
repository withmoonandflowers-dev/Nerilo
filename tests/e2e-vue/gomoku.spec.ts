/**
 * web-vue 房內小遊戲：五子棋雙向對戰（與井字棋共用同一條 mesh game 通道，ns:'gomoku'）。
 * 證明「加新遊戲」路徑順暢：切到五子棋分頁 → 落子雙向可見 → 回合輪替。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, createRoom, joinRoom, expectChatReady, teardown } from './_helpers/users';

const BOARD = 15;
const idx = (r: number, c: number) => r * BOARD + c;
const cell = (page: Page, i: number) => page.getByTestId(`gmk-cell-${i}`);

test.describe('Vue 版五子棋', () => {
  test('切到五子棋、落子雙向可見、黑白回合輪替', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 開遊戲面板並切到五子棋分頁（雙方）
      for (const p of [alice.page, bob.page]) {
        await p.getByRole('button', { name: '開啟遊戲' }).click();
        await p.getByTestId('game-tab-gomoku').click();
      }
      // 房主 = 黑（先手）
      await expect(alice.page.getByTestId('gmk-status')).toHaveText('輪到你（黑）');
      await expect(bob.page.getByTestId('gmk-status')).toHaveText('等待對方（黑）');

      // A（黑）落子 → 本地黑、B 端看到黑
      await cell(alice.page, idx(7, 7)).click();
      await expect(cell(alice.page, idx(7, 7))).toHaveClass(/gmk__cell--b/);
      await expect(cell(bob.page, idx(7, 7))).toHaveClass(/gmk__cell--b/, { timeout: 10_000 });
      await expect(bob.page.getByTestId('gmk-status')).toHaveText('輪到你（白）', { timeout: 10_000 });

      // B（白）落子 → A 端看到白，且回合回到黑
      await cell(bob.page, idx(7, 8)).click();
      await expect(cell(alice.page, idx(7, 8))).toHaveClass(/gmk__cell--w/, { timeout: 10_000 });
      await expect(alice.page.getByTestId('gmk-status')).toHaveText('輪到你（黑）');
    } finally {
      await teardown(alice, bob);
    }
  });
});
