/**
 * Spec 028 A2 信使模擬 E2E。
 *
 * courier 與 relay overlay 目前只在 Vue 線接線，React 生產線沒有這條路徑。
 * 本檔採同一個 A context 離開房間再回來的降級劇本，不證明 close-context restore，
 * 也不證明 PULL 已完成房籍授權。R8 測試只釘住現況，修法由 Spec 029 處理。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  uniqueMessage,
  expectExactlyOnce,
  teardown,
} from './_helpers/users';

const ATTEMPTS = 5;

interface RelayRecord {
  roomId: string;
  senderId: string;
  pubKey: string;
  sessionEpoch: number;
  seq: number;
  timestamp: number;
  content: string;
  ttl: number;
  signature: string;
  messageId?: string;
  channel?: string;
}

interface ReplicaEntry {
  key: string;
  recordJson: string;
  record: RelayRecord;
}

interface BackupSummary {
  rooms: number;
  received: number;
  pushed: number;
}

interface CourierStats {
  recordCount: number;
  roomCount: number;
}

function recordKey(record: RelayRecord): string {
  return `${record.roomId}:${record.senderId}:${record.sessionEpoch}:${record.seq}`;
}

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]!;
}

async function ownerUid(page: Page): Promise<string> {
  const uid = await page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { auth?: { currentUser?: { uid?: string } | null } };
    };
    return w.__nerilo_test__?.auth?.currentUser?.uid ?? '';
  });
  if (!uid) throw new Error('test hook auth.currentUser.uid 不可用');
  return uid;
}

async function waitDashboardServices(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as {
            __nerilo_test__?: {
              relay?: { courierStats?: () => unknown };
              backup?: { runOnce?: () => unknown };
              presence?: { announcing?: () => boolean };
            };
          };
          return Boolean(
            w.__nerilo_test__?.relay?.courierStats &&
              w.__nerilo_test__?.backup?.runOnce &&
              w.__nerilo_test__?.presence?.announcing?.()
          );
        }),
      { timeout: 20_000, intervals: [250] }
    )
    .toBe(true);
}

async function meshNodeId(page: Page): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as {
            __nerilo_test__?: { relay?: { myNodeId?: () => string } };
          };
          return w.__nerilo_test__?.relay?.myNodeId?.() ?? '';
        }),
      { timeout: 20_000, intervals: [250] }
    )
    .toHaveLength(32);
  return page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { relay?: { myNodeId?: () => string } };
    };
    return w.__nerilo_test__!.relay!.myNodeId!();
  });
}

async function firstCourierUid(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __nerilo_test__?: {
        backup?: { debug?: () => Promise<{ courierUids: string[] | string }> };
      };
    };
    const courierUids = (await w.__nerilo_test__!.backup!.debug!()).courierUids;
    return Array.isArray(courierUids) ? courierUids[0] ?? '' : '';
  });
}

async function prioritiseCourier(courier: Page, requester: Page, courierUid: string): Promise<void> {
  await courier.reload();
  await expect(courier).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  await waitDashboardServices(courier);
  await expect
    .poll(() => firstCourierUid(requester), { timeout: 20_000, intervals: [500] })
    .toBe(courierUid);
}

async function courierStats(page: Page): Promise<CourierStats> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __nerilo_test__?: { relay?: { courierStats?: () => CourierStats } };
    };
    return w.__nerilo_test__!.relay!.courierStats!();
  });
}

async function flushCourier(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __nerilo_test__?: { relay?: { flushCourier?: () => Promise<void> } };
    };
    await w.__nerilo_test__!.relay!.flushCourier!();
  });
}

async function runBackup(page: Page): Promise<BackupSummary> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __nerilo_test__?: { backup?: { runOnce?: () => Promise<BackupSummary> } };
    };
    return w.__nerilo_test__!.backup!.runOnce!();
  });
}

async function reconcile(page: Page, courierUid: string, roomId: string): Promise<RelayRecord[]> {
  return page.evaluate(
    async ({ uid, targetRoomId }) => {
      const w = window as unknown as {
        __nerilo_test__?: {
          relay?: {
            reconcile?: (
              courier: string,
              room: string,
              localRecords: RelayRecord[]
            ) => Promise<{ received: RelayRecord[]; pushed: number }>;
          };
        };
      };
      const result = await w.__nerilo_test__!.relay!.reconcile!(uid, targetRoomId, []);
      return result.received;
    },
    { uid: courierUid, targetRoomId: roomId }
  );
}

async function readReplicaEntries(page: Page, roomId: string): Promise<ReplicaEntry[]> {
  return page.evaluate(async (targetRoomId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('NeriloReplica');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<Array<{ recordJson: string }>>((resolve, reject) => {
        const transaction = db.transaction('records2', 'readonly');
        const request = transaction
          .objectStore('records2')
          .index('roomId')
          .getAll(IDBKeyRange.only(targetRoomId));
        request.onsuccess = () => resolve(request.result as Array<{ recordJson: string }>);
        request.onerror = () => reject(request.error);
      });
      return rows.map(({ recordJson }) => {
        const record = JSON.parse(recordJson) as RelayRecord;
        return {
          key: `${record.roomId}:${record.senderId}:${record.sessionEpoch}:${record.seq}`,
          recordJson,
          record,
        };
      });
    } finally {
      db.close();
    }
  }, roomId);
}

async function leaveToDashboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: '離開房間' }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  await waitDashboardServices(page);
}

test.describe('Spec 028 A2 信使模擬 @courier', () => {
  test('B 經 C 寄存，A 同 context 回房補收五則且恰好一次', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const courier = await setupUser(browser);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);

    try {
      await waitDashboardServices(courier.page);
      await waitDashboardServices(bob.page);
      const courierUid = await ownerUid(courier.page);
      const bobNodeId = await meshNodeId(bob.page);

      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const baselineFromAlice = uniqueMessage('A2-key-ready-A');
      const baselineFromBob = uniqueMessage('A2-key-ready-B');
      await sendMessage(alice.page, baselineFromAlice);
      await expectExactlyOnce(bob.page, baselineFromAlice);
      await sendMessage(bob.page, baselineFromBob);
      await expectExactlyOnce(alice.page, baselineFromBob);

      await expect
        .poll(
          async () =>
            (await readReplicaEntries(bob.page, roomId)).filter(
              ({ record }) =>
                record.senderId === bobNodeId && (record.channel === undefined || record.channel === 'chat')
            ).length,
          { timeout: 10_000, intervals: [250] }
        )
        .toBeGreaterThanOrEqual(1);
      const beforeKeys = new Set((await readReplicaEntries(bob.page, roomId)).map(({ key }) => key));

      await leaveToDashboard(alice.page);

      const messages: Array<{ text: string; sentAt: number }> = [];
      for (let index = 0; index < ATTEMPTS; index += 1) {
        const text = uniqueMessage(`A2-relay-${index + 1}`);
        const sentAt = Date.now();
        await sendMessage(bob.page, text);
        await expectExactlyOnce(bob.page, text);
        messages.push({ text, sentAt });
      }

      await expect
        .poll(
          async () =>
            (await readReplicaEntries(bob.page, roomId)).filter(
              ({ key, record }) =>
                !beforeKeys.has(key) &&
                record.senderId === bobNodeId &&
                (record.channel === undefined || record.channel === 'chat')
            ).length,
          { timeout: 10_000, intervals: [250] }
        )
        .toBe(ATTEMPTS);

      const sourceEntries = (await readReplicaEntries(bob.page, roomId))
        .filter(
          ({ key, record }) =>
            !beforeKeys.has(key) &&
            record.senderId === bobNodeId &&
            (record.channel === undefined || record.channel === 'chat')
        )
        .sort((left, right) => left.record.seq - right.record.seq);
      expect(sourceEntries).toHaveLength(ATTEMPTS);

      await leaveToDashboard(bob.page);
      await prioritiseCourier(courier.page, bob.page, courierUid);
      const statsBeforeDeposit = await courierStats(courier.page);
      const depositSummary = await runBackup(bob.page);
      expect(depositSummary.pushed).toBeGreaterThanOrEqual(ATTEMPTS);
      await expect
        .poll(() => courierStats(courier.page).then(({ recordCount }) => recordCount), {
          timeout: 15_000,
          intervals: [250],
        })
        .toBeGreaterThanOrEqual(statsBeforeDeposit.recordCount + ATTEMPTS);
      const depositObservedAt = Date.now();
      await flushCourier(courier.page);
      await bob.ctx.close();

      await prioritiseCourier(courier.page, alice.page, courierUid);
      const backfillStartedAt = Date.now();
      const pulled = await reconcile(alice.page, courierUid, roomId);
      const pulledByKey = new Map(pulled.map((record) => [recordKey(record), record]));
      const ciphertextChecks = sourceEntries.map(({ key, recordJson }) => {
        const received = pulledByKey.get(key);
        return received !== undefined && JSON.stringify(received) === recordJson;
      });
      expect(ciphertextChecks).toEqual(Array(ATTEMPTS).fill(true));

      const backfillSummary = await runBackup(alice.page);
      expect(backfillSummary.received).toBeGreaterThanOrEqual(ATTEMPTS);
      const expectedKeys = new Set(sourceEntries.map(({ key }) => key));
      await expect
        .poll(
          async () =>
            (await readReplicaEntries(alice.page, roomId)).filter(({ key }) => expectedKeys.has(key)).length,
          { timeout: 10_000, intervals: [250] }
        )
        .toBe(ATTEMPTS);

      await alice.page.locator('.room-row').first().click();
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
      const deliveryResults = await Promise.all(
        messages.map(async ({ text, sentAt }, index) => {
          await expectExactlyOnce(alice.page, text, 15_000);
          const deliveredAt = Date.now();
          return {
            messageId: sourceEntries[index]!.record.messageId ?? sourceEntries[index]!.key,
            delivered: true,
            duplicate: false,
            ciphertextUnchanged: ciphertextChecks[index]!,
            depositMs: depositObservedAt - sentAt,
            backfillMs: deliveredAt - backfillStartedAt,
            completeMs: deliveredAt - sentAt,
          };
        })
      );

      const depositLatencies = deliveryResults.map(({ depositMs }) => depositMs);
      const backfillLatencies = deliveryResults.map(({ backfillMs }) => backfillMs);
      const completeLatencies = deliveryResults.map(({ completeMs }) => completeMs);
      const delivered = deliveryResults.length;
      const metrics = {
        attempts: ATTEMPTS,
        delivered,
        successRate: (delivered / ATTEMPTS) * 100,
        duplicateCount: 0,
        depositP50Ms: percentile(depositLatencies, 50),
        depositP95Ms: percentile(depositLatencies, 95),
        backfillP50Ms: percentile(backfillLatencies, 50),
        backfillP95Ms: percentile(backfillLatencies, 95),
        completeP50Ms: percentile(completeLatencies, 50),
        completeP95Ms: percentile(completeLatencies, 95),
        rounds: deliveryResults,
        measurement: {
          deposit: '每則 B 送出至 C 確認整批寄存完成',
          backfill: 'A 首次向 C 對帳至畫面完成恰好一次驗證',
          batching: '五則紀錄由同一輪 production backup 寄存與補收',
        },
        boundaries: {
          closeContextRestore: false,
          pullAuthorised: false,
          physicalDevicesTested: false,
        },
      };

      console.log(`PEER_RELAY_METRICS=${JSON.stringify(metrics)}`);
      await testInfo.attach('peer-relay-metrics', {
        body: JSON.stringify(metrics),
        contentType: 'application/json',
      });
    } finally {
      await teardown(alice, bob, courier);
    }
  });

  test('R8 characterization：非房成員目前可 PULL 密文，這不是期望行為 @courier', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const courier = await setupUser(browser);
    const roomOwner = await setupUser(browser);
    const outsider = await setupUser(browser);

    try {
      await waitDashboardServices(courier.page);
      const courierUid = await ownerUid(courier.page);
      const ownerNodeId = await meshNodeId(roomOwner.page);
      const roomId = await createRoom(roomOwner.page);
      await joinRoom(courier.page, roomId);
      await expectChatReady(roomOwner.page);
      await expectChatReady(courier.page);

      const beforeKeys = new Set(
        (await readReplicaEntries(roomOwner.page, roomId)).map(({ key }) => key)
      );
      const text = uniqueMessage('R8-characterization');
      await sendMessage(roomOwner.page, text);
      await expectExactlyOnce(courier.page, text);
      await expect
        .poll(
          async () =>
            (await readReplicaEntries(roomOwner.page, roomId)).filter(
              ({ key, record }) =>
                !beforeKeys.has(key) &&
                record.senderId === ownerNodeId &&
                (record.channel === undefined || record.channel === 'chat')
            ).length,
          { timeout: 10_000, intervals: [250] }
        )
        .toBe(1);
      const source = (await readReplicaEntries(roomOwner.page, roomId)).find(
        ({ key, record }) =>
          !beforeKeys.has(key) &&
          record.senderId === ownerNodeId &&
          (record.channel === undefined || record.channel === 'chat')
      );
      expect(source).toBeDefined();

      await leaveToDashboard(courier.page);
      await leaveToDashboard(roomOwner.page);
      await prioritiseCourier(courier.page, roomOwner.page, courierUid);
      const statsBeforeDeposit = await courierStats(courier.page);
      const depositSummary = await runBackup(roomOwner.page);
      expect(depositSummary.pushed).toBeGreaterThanOrEqual(1);
      await expect
        .poll(() => courierStats(courier.page).then(({ recordCount }) => recordCount), {
          timeout: 15_000,
          intervals: [250],
        })
        .toBeGreaterThanOrEqual(statsBeforeDeposit.recordCount + 1);

      await waitDashboardServices(outsider.page);
      const pulled = await reconcile(outsider.page, courierUid, roomId);
      const received = pulled.find((candidate) => recordKey(candidate) === source!.key);
      expect(received).toBeDefined();
      expect(JSON.stringify(received)).toBe(source!.recordJson);

      // outsider 是第三個身分，從未加入 roomId，卻能以 reconcile 的 PULL 取回真實已簽密文。
      // 這是 R8 現況，不是期望行為。Spec 029 修好房籍授權後，本測試應轉紅，提醒同步改成拒絕非成員的負向案例。
    } finally {
      await teardown(roomOwner, outsider, courier);
    }
  });
});
