/**
 * Spec 028 C2 信使中途失效 E2E。
 *
 * 本檔只驗 Vue 生產線已接線的 courier overlay。A 的 production backup 先用 C1，
 * C1 context 關閉後，同一輪候選切換到 C2，並以 IndexedDB 複合鍵確認本地紀錄不重不漏。
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

interface BackupSummary {
  rooms: number;
  received: number;
  pushed: number;
  switches?: Array<{ from: string; to: string; ms: number }>;
}

interface CourierStats {
  recordCount: number;
  roomCount: number;
}

interface ReplicaEntry {
  key: string;
}

async function currentUid(page: Page): Promise<string> {
  const uid = await page.evaluate(() => {
    const hook = (window as unknown as {
      __nerilo_test__?: { auth?: { currentUser?: { uid?: string } | null } };
    }).__nerilo_test__;
    return hook?.auth?.currentUser?.uid ?? '';
  });
  if (!uid) throw new Error('test hook auth.currentUser.uid 不可用');
  return uid;
}

async function waitDashboardServices(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook = (window as unknown as {
            __nerilo_test__?: {
              relay?: { courierStats?: () => unknown };
              backup?: { runOnce?: () => unknown; debug?: () => unknown };
              presence?: { announcing?: () => boolean };
            };
          }).__nerilo_test__;
          return Boolean(
            hook?.relay?.courierStats &&
              hook.backup?.runOnce &&
              hook.backup.debug &&
              hook.presence?.announcing?.()
          );
        }),
      { timeout: 20_000, intervals: [250] }
    )
    .toBe(true);
}

async function candidateUids(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const hook = (window as unknown as {
      __nerilo_test__?: {
        backup?: { debug?: () => Promise<{ courierUids: string[] | string }> };
      };
    }).__nerilo_test__;
    const value = (await hook!.backup!.debug!()).courierUids;
    return Array.isArray(value) ? value : [];
  });
}

async function prioritiseCouriers(
  requester: Page,
  first: { page: Page; uid: string },
  second: { page: Page; uid: string }
): Promise<void> {
  // directory 以最近公告者優先。先刷新 C2，再刷新 C1，固定本案例的候選順序。
  await second.page.reload();
  await expect(second.page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  await waitDashboardServices(second.page);
  await first.page.reload();
  await expect(first.page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  await waitDashboardServices(first.page);
  await expect
    .poll(() => candidateUids(requester), { timeout: 20_000, intervals: [500] })
    .toEqual(expect.arrayContaining([first.uid, second.uid]));
  await expect
    .poll(() => candidateUids(requester).then((uids) => uids[0]), {
      timeout: 20_000,
      intervals: [500],
    })
    .toBe(first.uid);
}

async function courierStats(page: Page): Promise<CourierStats> {
  return page.evaluate(() => {
    const hook = (window as unknown as {
      __nerilo_test__?: { relay?: { courierStats?: () => CourierStats } };
    }).__nerilo_test__;
    return hook!.relay!.courierStats!();
  });
}

async function flushCourier(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hook = (window as unknown as {
      __nerilo_test__?: { relay?: { flushCourier?: () => Promise<void> } };
    }).__nerilo_test__;
    await hook!.relay!.flushCourier!();
  });
}

async function runBackup(page: Page): Promise<BackupSummary> {
  return page.evaluate(async () => {
    const hook = (window as unknown as {
      __nerilo_test__?: { backup?: { runOnce?: () => Promise<BackupSummary> } };
    }).__nerilo_test__;
    return hook!.backup!.runOnce!();
  });
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
        const record = JSON.parse(recordJson) as {
          roomId: string;
          senderId: string;
          sessionEpoch: number;
          seq: number;
        };
        return {
          key: `${record.roomId}:${record.senderId}:${record.sessionEpoch}:${record.seq}`,
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

test.describe('Spec 028 C2 信使切換 @courier', () => {
  test('C1 中途失效後同一輪切換 C2，備份紀錄不重不漏', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const courier1 = await setupUser(browser);
    const courier2 = await setupUser(browser);
    const alice = await setupUser(browser);

    try {
      await waitDashboardServices(courier1.page);
      await waitDashboardServices(courier2.page);
      const courier1Uid = await currentUid(courier1.page);
      const courier2Uid = await currentUid(courier2.page);

      const roomId = await createRoom(alice.page);
      await joinRoom(courier1.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(courier1.page);

      const localCountBeforeMessage = (await readReplicaEntries(alice.page, roomId)).length;
      const message = uniqueMessage('C2-courier-failover');
      await sendMessage(alice.page, message);
      await expectExactlyOnce(courier1.page, message);
      await expect
        .poll(
          () => readReplicaEntries(alice.page, roomId).then((entries) => entries.length),
          { timeout: 10_000, intervals: [250] }
        )
        .toBeGreaterThan(localCountBeforeMessage);

      await leaveToDashboard(courier1.page);
      await leaveToDashboard(alice.page);
      await prioritiseCouriers(
        alice.page,
        { page: courier1.page, uid: courier1Uid },
        { page: courier2.page, uid: courier2Uid }
      );

      const courier1Before = await courierStats(courier1.page);
      const firstSummary = await runBackup(alice.page);
      expect(firstSummary.pushed).toBeGreaterThanOrEqual(1);
      expect(firstSummary.switches ?? []).toHaveLength(0);
      await expect
        .poll(() => courierStats(courier1.page).then(({ recordCount }) => recordCount), {
          timeout: 15_000,
          intervals: [250],
        })
        .toBeGreaterThan(courier1Before.recordCount);
      await flushCourier(courier1.page);

      const beforeFailover = await readReplicaEntries(alice.page, roomId);
      const beforeKeys = beforeFailover.map(({ key }) => key).sort();
      await courier1.ctx.close();

      const courier2Before = await courierStats(courier2.page);
      const secondSummary = await runBackup(alice.page);
      const switchMetric = secondSummary.switches?.find(
        ({ from, to }) => from === courier1Uid && to === courier2Uid
      );
      expect(switchMetric).toBeDefined();
      expect(switchMetric!.ms).toBeGreaterThan(0);
      await expect
        .poll(() => courierStats(courier2.page).then(({ recordCount }) => recordCount), {
          timeout: 15_000,
          intervals: [250],
        })
        .toBeGreaterThan(courier2Before.recordCount);

      const afterFailover = await readReplicaEntries(alice.page, roomId);
      expect(afterFailover.map(({ key }) => key).sort()).toEqual(beforeKeys);
      expect(new Set(afterFailover.map(({ key }) => key)).size).toBe(beforeKeys.length);

      await testInfo.attach('courier-switch-metrics', {
        body: JSON.stringify({
          from: courier1Uid,
          to: courier2Uid,
          switchMs: switchMetric!.ms,
          firstSummary,
          secondSummary,
          localRecordsBefore: beforeFailover.length,
          localRecordsAfter: afterFailover.length,
        }),
        contentType: 'application/json',
      });
    } finally {
      await teardown(alice, courier1, courier2);
    }
  });
});
