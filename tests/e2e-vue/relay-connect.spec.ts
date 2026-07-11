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

/** 本瀏覽器信使 store 統計（test hook 暴露的 CourierStore.stats）。 */
async function courierStats(page: Page): Promise<{ recordCount: number; roomCount: number }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { relay?: { courierStats?: () => { recordCount: number; roomCount: number } } };
    };
    return w.__nerilo_test__?.relay?.courierStats?.() ?? { recordCount: 0, roomCount: 0 };
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

  test('anti-entropy 自動對帳：信使補成員缺的、成員回推信使缺的（雙向，P4-C）', async ({ browser }) => {
    test.setTimeout(150_000);
    const member = await setupUser(browser);
    const courier = await setupUser(browser);
    try {
      const courierUid = await ownerUid(courier.page);

      // 先讓信使持有 A（模擬別的成員先前寄存過）。
      const A = {
        roomId: 'room-y', senderId: 'sA', pubKey: 'pk', seq: 1, timestamp: 1,
        content: 'ENC:record-A', ttl: 3, signature: 'SIG-A', messageId: 'A',
      };
      await member.page.evaluate(
        async ({ uid, rec }) => {
          const w = window as unknown as {
            __nerilo_test__?: { relay?: { depositAndPull?: (u: string, r: unknown) => Promise<unknown[]> } };
          };
          await w.__nerilo_test__!.relay!.depositAndPull!(uid, rec);
        },
        { uid: courierUid, rec: A }
      );

      // 成員本地只有 B（缺 A）。一輪 reconcile 後：成員收到 A、且把 B 回推給信使。
      const B = {
        roomId: 'room-y', senderId: 'sB', pubKey: 'pk', seq: 1, timestamp: 2,
        content: 'ENC:record-B', ttl: 3, signature: 'SIG-B', messageId: 'B',
      };
      const result = await member.page.evaluate(
        async ({ uid, local }) => {
          const w = window as unknown as {
            __nerilo_test__?: {
              relay?: {
                reconcile?: (u: string, room: string, recs: unknown[]) => Promise<{ received: Array<Record<string, unknown>>; pushed: number }>;
              };
            };
          };
          return w.__nerilo_test__!.relay!.reconcile!(uid, 'room-y', [local]);
        },
        { uid: courierUid, local: B }
      );

      // 方向一：成員收到信使代管的 A（離線間隙自動回填）。
      expect(result.received.map((m) => m.messageId)).toContain('A');
      const gotA = result.received.find((m) => m.messageId === 'A')!;
      expect(gotA.content).toBe('ENC:record-A'); // 密文原樣
      // 方向二：成員把 B 回推信使（信使先前沒有）。
      expect(result.pushed).toBe(1);

      // 驗信使現在兩筆都有：成員再 pull 一次，應看到 A + B。
      const pulled = await member.page.evaluate(
        async ({ uid }) => {
          const w = window as unknown as {
            __nerilo_test__?: { relay?: { depositAndPull?: (u: string, r: unknown) => Promise<Array<Record<string, unknown>>> } };
          };
          // 用一筆已存在的 A 觸發 pull（deposit 冪等 duplicate；回傳該房全部）。
          const probe = { roomId: 'room-y', senderId: 'sA', pubKey: 'pk', seq: 1, timestamp: 1, content: 'ENC:record-A', ttl: 3, signature: 'SIG-A', messageId: 'A' };
          return w.__nerilo_test__!.relay!.depositAndPull!(uid, probe);
        },
        { uid: courierUid }
      );
      expect(pulled.map((m) => m.messageId).sort()).toEqual(['A', 'B']);
    } finally {
      await teardown(member, courier);
    }
  });

  test('production 觸發：成員背景備份把持久房間紀錄自動寄存給線上信使（P4-C app 整合）', async ({ browser }) => {
    test.setTimeout(150_000);
    const member = await setupUser(browser);
    const courier = await setupUser(browser);
    try {
      const courierUid = await ownerUid(courier.page);
      // 兩節點都在 dashboard 宣告 presence → 成員的 discover 才查得到信使。
      await expect(member.page.getByTestId('online-node-count')).toBeVisible({ timeout: 40_000 });

      // 成員的持久層（IndexedDB）先有一筆密文紀錄（模擬曾在 room-z 收發過訊息）。
      const record = {
        roomId: 'room-z', senderId: 'sMember', pubKey: 'pk', seq: 3, timestamp: 5,
        content: 'ENC:persisted-record', ttl: 3, signature: 'SIG-Z', messageId: 'Z',
      };
      await member.page.evaluate(async (rec) => {
        const w = window as unknown as {
          __nerilo_test__?: { backup?: { seedRecord?: (room: string, r: unknown) => Promise<void> } };
        };
        await w.__nerilo_test__!.backup!.seedRecord!('room-z', rec);
      }, record);

      // 等到「本次的線上信使」成為成員發現清單的最新候選（presence 每 5s 續期，前面測試
      // 已拆除的殭屍節點宣告會凍結、逐漸落後）。避免共用 emulator 名冊殘留造成跨測干擾。
      await expect
        .poll(
          () =>
            member.page.evaluate(async () => {
              const w = window as unknown as {
                __nerilo_test__?: { backup?: { debug?: () => Promise<{ courierUids: string[] }> } };
              };
              return (await w.__nerilo_test__!.backup!.debug!()).courierUids;
            }),
          { timeout: 40_000, intervals: [1000] }
        )
        .toContain(courierUid);
      // 進一步等到 live 信使排在最前（最新），確保備份第一個候選就打中它、不空耗殭屍節點。
      await expect
        .poll(
          () =>
            member.page.evaluate(async () => {
              const w = window as unknown as {
                __nerilo_test__?: { backup?: { debug?: () => Promise<{ courierUids: string[] }> } };
              };
              return (await w.__nerilo_test__!.backup!.debug!()).courierUids[0];
            }),
          { timeout: 40_000, intervals: [1000] }
        )
        .toBe(courierUid);

      // 跑一輪「真 production 備份」（runCourierBackup + 真 deps；只是不等 30s interval）。
      const summary = await member.page.evaluate(async () => {
        const w = window as unknown as {
          __nerilo_test__?: { backup?: { runOnce?: () => Promise<{ rooms: number; received: number; pushed: number }> } };
        };
        return w.__nerilo_test__!.backup!.runOnce!();
      });

      // 成員把 room-z 的紀錄推給了信使。
      expect(summary.pushed).toBeGreaterThanOrEqual(1);

      // 信使端確實收下了（透過 100% production 路徑：runCourierBackup→reconcile→CourierServer→store）。
      await expect
        .poll(() => courierStats(courier.page).then((s) => s.recordCount), { timeout: 20_000, intervals: [500] })
        .toBeGreaterThanOrEqual(1);
    } finally {
      await teardown(member, courier);
    }
  });

  test('房籍簽章墓碑：成員真簽墓碑 → 信使盲驗通過、刪整房（P4-C tombstone）', async ({ browser }) => {
    test.setTimeout(150_000);
    const member = await setupUser(browser);
    const courier = await setupUser(browser);
    try {
      const courierUid = await ownerUid(courier.page);
      await expect(member.page.getByTestId('online-node-count')).toBeVisible({ timeout: 40_000 });

      // 取成員的 mesh 身分（nodeId=senderId），構造一筆「本人貢獻」的紀錄寄存給信使
      // → 信使 store 有此 senderId，房籍驗證才成立。nodeId 由 IdentityManager 非同步導出 → 輪詢。
      await expect
        .poll(
          () =>
            member.page.evaluate(() => {
              const w = window as unknown as { __nerilo_test__?: { relay?: { myNodeId?: () => string } } };
              return w.__nerilo_test__?.relay?.myNodeId?.() ?? '';
            }),
          { timeout: 20_000, intervals: [500] }
        )
        .toHaveLength(32);
      const nodeId = await member.page.evaluate(() => {
        const w = window as unknown as { __nerilo_test__?: { relay?: { myNodeId?: () => string } } };
        return w.__nerilo_test__!.relay!.myNodeId!();
      });

      const record = {
        roomId: 'room-t', senderId: nodeId, pubKey: 'pk', seq: 1, timestamp: 9,
        content: 'ENC:to-be-tombstoned', ttl: 3, signature: 'SIG-T', messageId: 'T',
      };
      await member.page.evaluate(
        async ({ uid, rec }) => {
          const w = window as unknown as {
            __nerilo_test__?: { relay?: { depositAndPull?: (u: string, r: unknown) => Promise<unknown[]> } };
          };
          await w.__nerilo_test__!.relay!.depositAndPull!(uid, rec);
        },
        { uid: courierUid, rec: record }
      );
      await expect
        .poll(() => courierStats(courier.page).then((s) => s.recordCount), { timeout: 20_000, intervals: [500] })
        .toBeGreaterThanOrEqual(1);

      // 成員以房籍身分真簽墓碑 → 送給信使 → 信使盲驗（簽章 + senderId∈store）通過 → 刪整房。
      const freed = await member.page.evaluate(
        async ({ uid }) => {
          const w = window as unknown as {
            __nerilo_test__?: { relay?: { sendTombstone?: (u: string, room: string) => Promise<number> } };
          };
          return w.__nerilo_test__!.relay!.sendTombstone!(uid, 'room-t');
        },
        { uid: courierUid }
      );
      expect(freed).toBeGreaterThan(0);

      // 信使 room-t 已清空。
      await expect
        .poll(() => courierStats(courier.page).then((s) => s.recordCount), { timeout: 10_000, intervals: [500] })
        .toBe(0);
    } finally {
      await teardown(member, courier);
    }
  });
});
