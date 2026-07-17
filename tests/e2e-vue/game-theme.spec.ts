/**
 * web-vue 整合頁：井字棋雙向對戰 + 主題跟隨系統深淺。
 *
 * 主題段 2026-07-17 改寫（Spec 006 T1 拍板：單一乾淨主題＋深淺自動）：
 * 原「預設 neo + 循環切換」已退役——改斷言 prefers-color-scheme 驅動 light/dark、
 * 且產品 UI 無切換鈕殘留。
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

const themeAttr = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));

test.describe('Vue 版遊戲 × 主題', () => {
  test('井字棋出招雙向可見、回合輪替；主題跟隨系統深淺 @vue-stable', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // 主題：跟隨系統——淺色＝基底（無 data-theme）、深色＝dark 覆蓋層，即時跟隨
      await alice.page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(async () => themeAttr(alice.page)).toBe(null);
      await alice.page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(async () => themeAttr(alice.page)).toBe('dark');
      await alice.page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(async () => themeAttr(alice.page)).toBe(null);

      // 收斂驗收：產品 UI 無主題切換鈕殘留（Spec 006 V3）
      await expect(alice.page.getByRole('button', { name: /切換主題/ })).toHaveCount(0);

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
    } finally {
      await teardown(alice, bob);
    }
  });
});
