/**
 * 全站節點 presence（ADR-0023 P4-A）：兩個互為陌生人的瀏覽器都開著 dashboard，
 * 各自向 relayDirectory 宣告在線、並查得對方。
 * 這是盲信使 overlay 的地基驗證:非成員也能被站級名冊發現(後續 B/C 才能建連補齊)。
 * 2026-07-17（Spec 006 T2）：dashboard 的節點數顯示已砍（拍板：兩鍵制首頁），
 * 機制照跑——斷言由 UI testid 改為 test hook（__nerilo_test__.presence）。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, teardown } from './_helpers/users';

const presenceOf = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { presence?: { peerCount?: () => number; announcing?: () => boolean } };
    };
    const p = w.__nerilo_test__?.presence;
    return p ? { peerCount: p.peerCount?.() ?? 0, announcing: p.announcing?.() ?? false } : null;
  });

test.describe('全站節點 presence（P4-A）', () => {
  test('兩瀏覽器在 dashboard 互相發現（線上節點數 ≥ 1）', async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // 兩者都停在 dashboard、都在宣告 presence；heartbeat 週期查詢後應看到對方。
      for (const page of [alice.page, bob.page]) {
        await expect
          .poll(async () => presenceOf(page), { timeout: 40_000 })
          .toMatchObject({ announcing: true });
        await expect
          .poll(async () => (await presenceOf(page))?.peerCount ?? 0, { timeout: 40_000 })
          .toBeGreaterThanOrEqual(1);
      }
    } finally {
      await teardown(alice, bob);
    }
  });
});
