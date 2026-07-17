/**
 * P2P 房間目錄（去中心化大廳第一片）：alice 開公開房後回 dashboard，bob（陌生節點、
 * 不同房）與 alice 建 relay 連線 → roomdir 廣播 → bob 的目錄快取出現 alice 的房，
 * 全程不經 Firestore 大廳查詢。驗簽保證廣告不可冒名（RoomDirectoryGossip 單元測試覆蓋）。
 * 2026-07-17（Spec 006 T2）：dashboard 顯示區塊已砍，斷言由 UI 改為 test hook。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, createRoom, teardown } from './_helpers/users';

async function ownerUid(page: Page): Promise<string> {
  const uid = await page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { auth?: { currentUser?: { uid?: string } | null } };
    };
    return w.__nerilo_test__?.auth?.currentUser?.uid ?? null;
  });
  if (!uid) throw new Error('test hook auth.currentUser.uid 不可用');
  return uid;
}

test.describe('P2P 房間目錄（roomdir over relay）', () => {
  test('bob 經 relay 廣播看到 alice 的公開房（不經大廳查詢）', async ({ browser }) => {
    // relay WebRTC 在模擬器下合法地慢，放寬整體 timeout（同 relay-connect）。
    test.setTimeout(150_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // alice 開公開房（Vue 建房預設公開），回 dashboard（廣告來源 = myRooms）
      const roomId = await createRoom(alice.page);
      await alice.page.goto('/dashboard');
      await expect(alice.page.locator('.room-row').first()).toBeVisible({ timeout: 10_000 });

      // bob 主動與 alice 建 relay 連線（走站級 relaySignals，兩人互不同房）
      const aliceUid = await ownerUid(alice.page);
      await bob.page.evaluate(async (uid) => {
        const w = window as unknown as {
          __nerilo_test__?: { relay?: { connectToRelayNode?: (u: string) => Promise<void> } };
        };
        await w.__nerilo_test__!.relay!.connectToRelayNode!(uid);
      }, aliceUid);

      // bob 的目錄快取出現 alice 的房（roomdir 廣播 → 驗簽後入快取）。
      // Spec 006 T2：dashboard 顯示已砍（拍板：兩鍵制首頁），機制照跑——
      // 斷言改走 test hook（__nerilo_test__.roomdir.list()），迴歸保護不降級。
      await expect
        .poll(
          async () =>
            bob.page.evaluate(() => {
              const w = window as unknown as {
                __nerilo_test__?: { roomdir?: { list?: () => Array<{ roomId: string }> } };
              };
              return w.__nerilo_test__?.roomdir?.list?.().map((ad) => ad.roomId) ?? [];
            }),
          { timeout: 60_000 }
        )
        .toContain(roomId);
      // 快取內容可導航（roomId 是真的房，路由對得上）
      await bob.page.goto(`/chat/${roomId}`);
      await expect(bob.page).toHaveURL(new RegExp(`/chat/${roomId}`), { timeout: 10_000 });
    } finally {
      await teardown(alice, bob);
    }
  });
});
