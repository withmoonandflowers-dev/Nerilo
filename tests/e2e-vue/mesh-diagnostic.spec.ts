/**
 * web-vue 3 人 mesh 診斷：矩陣全 =1（協議與 React 版 tests/e2e/mesh-diagnostic.spec.ts 同款）。
 * 可靠性本體（anti-entropy 對帳）在 React 版已連續兩批 5/5 驗證；
 * 本測試驗的是 Vue 接線（MeshChatService 掛載、送訊分支、橋接、UI 去重）。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  sendMessage,
  uniqueMessage,
  teardown,
} from './_helpers/users';

const DELIVERY_TIMEOUT_MS = 20_000;
const DUP_SETTLE_MS = 5_000;

test.describe('Vue 版 3 人 mesh 診斷', () => {
  test('每則訊息在每個畫面最終各恰好一次', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);

      // 等三人都進 mesh 且 ≥1 鄰居連上（mesh 橫幅 + 已連線）；不等 full mesh
      for (const page of [alice.page, bob.page, carol.page]) {
        await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
        await expect(page.locator('.chat__banner--info')).toBeVisible({ timeout: 60_000 });
        await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 60_000 });
      }

      const msgs: Array<[Page, string]> = [
        [alice.page, uniqueMessage('vdiag-A')],
        [bob.page, uniqueMessage('vdiag-B')],
        [carol.page, uniqueMessage('vdiag-C')],
      ];
      for (const [page, text] of msgs) await sendMessage(page, text);

      // 每格先等送達，再沉澱抓重複，最後矩陣全 =1
      for (const page of [alice.page, bob.page, carol.page]) {
        for (const [, text] of msgs) {
          await expect(page.locator('.bubble').filter({ hasText: text }).first()).toBeVisible({
            timeout: DELIVERY_TIMEOUT_MS,
          });
        }
      }
      await alice.page.waitForTimeout(DUP_SETTLE_MS);

      const matrix: string[] = [];
      const viewers: Array<[string, Page]> = [
        ['A', alice.page],
        ['B', bob.page],
        ['C', carol.page],
      ];
      for (const [name, page] of viewers) {
        const row: string[] = [];
        for (const [, text] of msgs) {
          row.push(String(await page.locator('.bubble').filter({ hasText: text }).count()));
        }
        matrix.push(`${name}: ${row.join(' ')}`);
      }
      console.log('=== Vue 送達矩陣 ===\n' + matrix.join('\n'));

      for (const [name, page] of viewers) {
        for (const [, text] of msgs) {
          await expect(
            page.locator('.bubble').filter({ hasText: text }),
            `${name} 畫面矩陣格應恰好 1`
          ).toHaveCount(1);
        }
      }
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
