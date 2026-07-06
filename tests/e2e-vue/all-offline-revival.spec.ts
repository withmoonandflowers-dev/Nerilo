/**
 * ADR-0023 驗收：全員斷線後重生（user 需求 2026-07-06）
 * 「房間 = 永續複寫日誌」——全員下線（無任何在線複本）後成員回來：
 *   a) 歷史從本地複本立即呈現（各恰好一次，不重不漏）
 *   b) 房間連線自動重建，新訊息照常互通
 * 沒有任何中央 session 概念可以「過期」。
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

async function leaveToDashboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: '離開房間' }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

async function reenterRoom(page: Page): Promise<void> {
  await page.locator('.room-row').first().click();
  await expectMeshReady(page);
}

test.describe('ADR-0023：全員斷線後重生', () => {
  test('三人全下線後回來：歷史各恰好一次、連線重建、新訊息互通', async ({ browser }) => {
    test.setTimeout(300_000);
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

      // 建立「斷線前的歷史」：三人各發一則、全網同步
      const hA = uniqueMessage('hist-A');
      const hB = uniqueMessage('hist-B');
      const hC = uniqueMessage('hist-C');
      await sendMessage(alice.page, hA);
      await sendMessage(bob.page, hB);
      await sendMessage(carol.page, hC);
      for (const page of [alice.page, bob.page, carol.page]) {
        for (const m of [hA, hB, hC]) await expectExactlyOnce(page, m, 30_000);
      }

      // ── 全員下線：依序離開，期間曾出現「零在線複本」──
      await leaveToDashboard(alice.page);
      await leaveToDashboard(bob.page);
      await leaveToDashboard(carol.page);
      await alice.page.waitForTimeout(3_000); // 確保所有 P2P 均已死透

      // ── 重生：A 先獨自回來 ──
      // a-核心) 房裡「沒有任何其他在線者」時，歷史必須先從本地複本渲染出來
      //（local-first：呈現不等連線——這正是「依據先前儲存的資料呈現」）
      await alice.page.locator('.room-row').first().click();
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
      for (const m of [hA, hB, hC]) await expectExactlyOnce(alice.page, m, 15_000);

      // 其餘成員回來 → 連線重建
      await reenterRoom(bob.page);
      await reenterRoom(carol.page);
      await expectMeshReady(alice.page);

      // a) 歷史在每人畫面各恰好一次（不重不漏——重生不得造成複製）
      for (const page of [alice.page, bob.page, carol.page]) {
        for (const m of [hA, hB, hC]) await expectExactlyOnce(page, m, 15_000);
      }

      // b) 連線重建、新訊息互通（雙向抽驗；seq 續增不碰撞）
      const nA = uniqueMessage('new-A');
      await sendMessage(alice.page, nA);
      await expectExactlyOnce(bob.page, nA, 30_000);
      await expectExactlyOnce(carol.page, nA, 30_000);

      const nC = uniqueMessage('new-C');
      await sendMessage(carol.page, nC);
      await expectExactlyOnce(alice.page, nC, 30_000);
      await expectExactlyOnce(bob.page, nC, 30_000);
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
