/**
 * 全站節點 presence（ADR-0023 P4-A）：兩個互為陌生人的瀏覽器都開著 dashboard，
 * 各自向 relayDirectory 宣告在線、並查得對方 → UI 顯示「還有 N 個節點一起守護」。
 * 這是盲信使 overlay 的地基驗證:非成員也能被站級名冊發現(後續 B/C 才能建連補齊)。
 */
import { test, expect } from '@playwright/test';
import { setupUser, teardown } from './_helpers/users';

test.describe('全站節點 presence（P4-A）', () => {
  test('兩瀏覽器在 dashboard 互相發現（線上節點數 ≥ 1）', async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // 兩者都停在 dashboard、都在宣告 presence；heartbeat 週期查詢後應看到對方。
      // testid 只在「announcing 且 peerCount>0」才渲染 → 可見即代表已發現 ≥1 個節點。
      await expect(alice.page.getByTestId('online-node-count')).toBeVisible({ timeout: 40_000 });
      await expect(bob.page.getByTestId('online-node-count')).toBeVisible({ timeout: 40_000 });

      const aCount = Number(await alice.page.getByTestId('online-node-count').textContent());
      const bCount = Number(await bob.page.getByTestId('online-node-count').textContent());
      expect(aCount).toBeGreaterThanOrEqual(1);
      expect(bCount).toBeGreaterThanOrEqual(1);
    } finally {
      await teardown(alice, bob);
    }
  });
});
