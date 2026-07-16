/**
 * web-vue 整合頁：井字棋雙向對戰 + neo 主題三態切換。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  teardown,
} from './_helpers/users';

function cell(page: Page, i: number) {
  return page.getByTestId(`ttt-cell-${i}`);
}

test.describe('Vue 版遊戲 × 主題', () => {
  test('井字棋出招雙向可見、回合輪替；neo 主題預設且可循環切換 @vue-stable', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // 主題：預設 neo
      await expect
        .poll(async () => alice.page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('neo');

      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 開遊戲面板（雙方）
      await alice.page.getByRole('button', { name: '開啟遊戲' }).click();
      await bob.page.getByRole('button', { name: '開啟遊戲' }).click();
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）');
      await expect(bob.page.getByTestId('ttt-status')).toHaveText('等待對方（X）');

      // A（房主 X）出招 → B 看到；B 回招 → A 看到
      await cell(alice.page, 0).click();
      await expect(cell(alice.page, 0)).toHaveText('X'); // 本地樂觀更新
      await expect(cell(bob.page, 0)).toHaveText('X', { timeout: 10_000 });
      await cell(bob.page, 4).click();
      await expect(cell(alice.page, 4)).toHaveText('O', { timeout: 10_000 });
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）');

      // 主題循環：neo → light → dark → neo
      const themeBtn = alice.page.getByRole('button', { name: /切換主題/ });
      await themeBtn.click();
      await expect
        .poll(async () => alice.page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe(null);
      await themeBtn.click();
      await expect
        .poll(async () => alice.page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('dark');
      await themeBtn.click();
      await expect
        .poll(async () => alice.page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('neo');
    } finally {
      await teardown(alice, bob);
    }
  });
});
