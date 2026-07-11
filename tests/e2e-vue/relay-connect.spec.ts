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

  test('盲信使寄存：member 把密文紀錄寄存給 courier，回線原樣取回（P4-C）', async ({ browser }) => {
    test.setTimeout(150_000);
    const member = await setupUser(browser); // 成員
    const courier = await setupUser(browser); // 盲信使（非成員）
    try {
      const courierUid = await ownerUid(courier.page);

      // member 連上 courier → 寄存一筆密文紀錄 → 立刻回線取回（同一真實 relay 通道往返）。
      const record = {
        roomId: 'room-x',
        senderId: 'sender-1',
        pubKey: 'pk',
        seq: 7,
        timestamp: 1000,
        content: 'ENC:blind-courier-ciphertext-payload',
        ttl: 3,
        signature: 'SIG-abc',
        messageId: 'msg-777',
      };
      const pulled = await member.page.evaluate(
        async ({ uid, rec }) => {
          const w = window as unknown as {
            __nerilo_test__?: {
              relay?: { depositAndPull?: (u: string, r: unknown) => Promise<unknown[]> };
            };
          };
          return w.__nerilo_test__!.relay!.depositAndPull!(uid, rec);
        },
        { uid: courierUid, rec: record }
      );

      // 取回的紀錄應與寄存的密文位元對位相同（盲存：信使沒改任何 byte）。
      expect(Array.isArray(pulled)).toBe(true);
      const got = (pulled as Array<Record<string, unknown>>).find((m) => m.messageId === 'msg-777');
      expect(got).toBeTruthy();
      expect(got!.content).toBe('ENC:blind-courier-ciphertext-payload');
      expect(got!.signature).toBe('SIG-abc');
      expect(got!.seq).toBe(7);
    } finally {
      await teardown(member, courier);
    }
  });
});
