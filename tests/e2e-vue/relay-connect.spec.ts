/**
 * 陌生節點站級連線（ADR-0023 P4-B）：兩個互不同房的瀏覽器都停在 dashboard，
 * alice 用 bob 的 firebase uid 主動發起 relay 連線 → 經 relaySignals（站級 signaling，
 * 不綁房）交換 offer/answer → relay-only DataChannel 真的連到 'connected'。
 *
 * 這證明 P4-A 發現之後「傳輸真的通」：非成員（盲信使）能被發現、且能建起連線，
 * 補齊 overlay 的最後一哩。誠實邊界：RelayConnector 的編排邏輯有單元測試，但
 * 「真的連上」只有真實 WebRTC + Firestore + 兩瀏覽器能證明——就是這支。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, teardown } from './_helpers/users';

/** 讀本瀏覽器登入者的 firebase uid（test hook 暴露的 auth.currentUser） */
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

/** 本瀏覽器 relay 連線狀態陣列（test hook 暴露的 RelayConnector.states） */
async function relayStates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { relay?: { states?: () => string[] } };
    };
    return w.__nerilo_test__?.relay?.states?.() ?? [];
  });
}

test.describe('陌生節點站級連線（P4-B）', () => {
  test('alice 主動連上陌生節點 bob，relay DataChannel 到 connected', async ({ browser }) => {
    // WebRTC/ICE 在模擬器下合法地慢（可達 30-60s），放寬整體 timeout。
    test.setTimeout(150_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // relay 掛鉤在 dashboard onMounted 掛上；等兩邊都就緒（能取到 uid 即代表 hook 已掛）。
      const bobUid = await ownerUid(bob.page);
      const aliceUid = await ownerUid(alice.page);
      expect(bobUid).not.toBe(aliceUid); // 互為陌生人

      // bob 已在 startListening（dashboard 掛鉤時啟動）；alice 主動發起。
      await alice.page.evaluate(async (uid) => {
        const w = window as unknown as {
          __nerilo_test__?: { relay?: { connectToRelayNode?: (u: string) => Promise<void> } };
        };
        await w.__nerilo_test__!.relay!.connectToRelayNode!(uid);
      }, bobUid);

      // 主動方連線應成形至 'connected'（offer→answer→ICE 經 relaySignals 完成）。
      await expect
        .poll(() => relayStates(alice.page), { timeout: 120_000, intervals: [1000] })
        .toContain('connected');

      // 中繼方（bob）也應建起對應的 responder 連線並連上。
      await expect
        .poll(() => relayStates(bob.page), { timeout: 30_000, intervals: [1000] })
        .toContain('connected');
    } finally {
      await teardown(alice, bob);
    }
  });
});
