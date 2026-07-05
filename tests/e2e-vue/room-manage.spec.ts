/**
 * web-vue 房間管理迴歸（Chrome 手測發現的兩個 bug 的鎖）：
 * 1. ⋯ 選單被列表卡片 overflow:hidden 裁切 → 房少時退出/刪除點不到（Teleport+fixed 修）
 * 2. 刪除/退出用 window.confirm → 阻塞 renderer + 破壞 neo（改自訂非阻塞 modal）
 * 也驗釘選 toggle + 狀態持久、刪除語義（單人房＝真刪）。
 */
import { test, expect } from '@playwright/test';
import { setupUser, createRoom, teardown } from './_helpers/users';

test.describe('Vue 版房間管理', () => {
  test('⋯選單三項完整可見；釘選 toggle 持久；刪除走自訂 modal 且真刪', async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await setupUser(browser);
    try {
      await createRoom(alice.page); // 停在 /waiting
      await alice.page.goto('/dashboard');

      const row = alice.page.locator('.room-row').first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      // 1) 選單三項都可見（單房時原本會被 overflow 裁掉退出/刪除）
      await row.locator('.room-row__more').click();
      const menu = alice.page.locator('.room-menu');
      await expect(menu.getByText('釘選置頂')).toBeVisible();
      await expect(menu.getByText('退出聊天室')).toBeVisible();
      await expect(menu.getByText('刪除聊天室')).toBeVisible();

      // 2) 釘選 → 房名前出現 📌；再開選單狀態變「取消釘選」（持久）
      await menu.getByText('釘選置頂').click();
      await expect(row.locator('.room-row__pin')).toBeVisible();
      await row.locator('.room-row__more').click();
      await expect(alice.page.locator('.room-menu').getByText('取消釘選')).toBeVisible();

      // 3) 點外部關閉選單（不再靠 window.confirm 阻塞或導航才關）
      await alice.page.mouse.click(200, 400);
      await expect(alice.page.locator('.room-menu')).toHaveCount(0);

      // 4) 刪除 → 自訂 modal（非 window.confirm）→ 確認 → 房消失、真刪 toast
      await row.locator('.room-row__more').click();
      await alice.page.locator('.room-menu').getByText('刪除聊天室').click();
      const dialog = alice.page.locator('.confirm');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.confirm__title')).toHaveText('刪除聊天室');
      await dialog.locator('.confirm__ok').click();

      // 單人房：所有成員皆刪 → 真刪；列表回空
      await expect(alice.page.locator('.room-row')).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await teardown(alice);
    }
  });

  test('刪除 modal 可取消，房間保留', async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await setupUser(browser);
    try {
      await createRoom(alice.page);
      await alice.page.goto('/dashboard');
      const row = alice.page.locator('.room-row').first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      await row.locator('.room-row__more').click();
      await alice.page.locator('.room-menu').getByText('刪除聊天室').click();
      await expect(alice.page.locator('.confirm')).toBeVisible();
      await alice.page.locator('.confirm__cancel').click();

      await expect(alice.page.locator('.confirm')).toHaveCount(0);
      await expect(alice.page.locator('.room-row')).toHaveCount(1);
    } finally {
      await teardown(alice);
    }
  });
});
