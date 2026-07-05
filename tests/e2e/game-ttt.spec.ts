/**
 * 遊戲 demo E2E（game-integration-spec 里程碑 1）：
 * 「連線 → 出招 → 對方看到」——遊戲第一次真的跑在 Nerilo 傳輸層上。
 *
 * 2 人星型房；遊戲事件走 P2P bus ns:'ttt'（可靠有序 + E2EE），
 * 不走 Firestore 備援——因此本測試要求真 P2P（banner 已連線，
 * 備援模式不接受；遊戲在備援下的正確行為是「對局暫停」）。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, createRoom, joinRoom, teardown } from './_helpers/users';

async function expectP2PConnected(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
  // 遊戲需要真 P2P：備援模式不算（會顯示對局暫停）
  await expect(page.locator('.connection-banner-text')).toHaveText(/已連線/, {
    timeout: 60_000,
  });
}

async function openGame(page: Page): Promise<void> {
  await page.getByRole('button', { name: '開啟遊戲' }).click();
  await expect(page.locator('.ttt-panel')).toBeVisible();
}

function cell(page: Page, i: number) {
  return page.getByTestId(`ttt-cell-${i}`);
}

test.describe('井字棋 on Nerilo（2 人星型）', () => {
  test('出招雙向可見、回合輪替正確', async ({ browser }) => {
    test.setTimeout(180_000); // 涵蓋 2 組註冊 + WebRTC 連線成形；出招斷言各 10s

    const alice = await setupUser(browser); // 房主 = X 先手
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectP2PConnected(alice.page);
      await expectP2PConnected(bob.page);

      await openGame(alice.page);
      await openGame(bob.page);

      // 初始回合狀態
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）');
      await expect(bob.page.getByTestId('ttt-status')).toHaveText('等待對方（X）');

      // A 出招 → 本地即時、對方 10s 內看到
      await cell(alice.page, 0).click();
      await expect(cell(alice.page, 0)).toHaveText('X');
      await expect(cell(bob.page, 0)).toHaveText('X', { timeout: 10_000 });
      await expect(bob.page.getByTestId('ttt-status')).toHaveText('輪到你（O）');

      // B 回招 → A 看到，回合回到 A
      await cell(bob.page, 4).click();
      await expect(cell(bob.page, 4)).toHaveText('O');
      await expect(cell(alice.page, 4)).toHaveText('O', { timeout: 10_000 });
      await expect(alice.page.getByTestId('ttt-status')).toHaveText('輪到你（X）');

      // 不是你的回合 → 格子鎖住（UI 層的 no-op 保證；點 disabled 元素會讓
      // Playwright 等待 enabled，所以斷言 disabled 而不是點下去）
      await expect(cell(bob.page, 8)).toBeDisabled();

      // 重新開始雙向生效
      await alice.page.getByRole('button', { name: '重新開始' }).click();
      await expect(cell(alice.page, 0)).toHaveText('');
      await expect(cell(bob.page, 0)).toHaveText('', { timeout: 10_000 });
    } finally {
      await teardown(alice, bob);
    }
  });

  test('晚開面板的一方經 SYNC 對齊盤面', async ({ browser }) => {
    test.setTimeout(180_000);

    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectP2PConnected(alice.page);
      await expectP2PConnected(bob.page);

      // 只有 A 開面板並先手；B 尚未訂閱 ns:'ttt'，會漏掉這則 MOVE
      await openGame(alice.page);
      await cell(alice.page, 4).click();
      await expect(cell(alice.page, 4)).toHaveText('X');

      // B 開面板 → SYNC_REQ/SYNC_STATE 對齊到進行中的盤面
      await openGame(bob.page);
      await expect(cell(bob.page, 4)).toHaveText('X', { timeout: 10_000 });
      await expect(bob.page.getByTestId('ttt-status')).toHaveText('輪到你（O）');
    } finally {
      await teardown(alice, bob);
    }
  });
});
