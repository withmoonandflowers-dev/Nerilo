/**
 * 這支測試會在以下情況變紅：任一房無法各自 mesh ready；拿掉 room 隔離後，A 房
 * 的唯一訊息出現在 B 房（或反向）；或 bootstrap 完成、四端 Firestore network 都被
 * disable 後，任一房無法再雙向送達新訊息。也就是說，跨房訊息即使只漏一則也會失敗，
 * 中央 signaling／Firestore fallback 若仍是 bootstrap 後收發的必要條件也會失敗。
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

const MESH_TIMEOUT_MS = 90_000;
const DELIVERY_TIMEOUT_MS = 30_000;
const ISOLATION_SETTLE_MS = 5_000;

async function expectMeshReady(page: Page): Promise<void> {
  await expectChatReady(page, MESH_TIMEOUT_MS);
  // chat__banner--info 只在 3 人以上顯示，不是兩人 mesh 的狀態證據。
  // 連線後再等到真實 room-key 安裝完成，避免把僅 WebRTC ready 誤當 E2EE ready。
  await expect(page.getByTestId('e2ee-encrypted')).toBeVisible({ timeout: MESH_TIMEOUT_MS });
}

/** 只切中央 Firestore（含 signaling/fallback），保留已建立的 WebRTC DataChannel。 */
async function cutCentralSignaling(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type FirestoreTestHook = {
      db?: unknown;
      firestore?: { disableNetwork?: (db: unknown) => Promise<void> };
    };
    const hook = (window as unknown as { __nerilo_test__?: FirestoreTestHook }).__nerilo_test__;
    if (!hook?.db || !hook.firestore?.disableNetwork) {
      throw new Error('test hook 缺少 Firestore disableNetwork，不能證明中央 signaling 已切斷');
    }
    await hook.firestore.disableNetwork(hook.db);
  });
}

async function expectAbsent(page: Page, text: string, viewer: string): Promise<void> {
  await expect(
    page.locator('.bubble').filter({ hasText: text }),
    `${viewer} 不得看見另一個房間的訊息：${text}`
  ).toHaveCount(0);
}

test.describe('多個獨立 mesh：bootstrap-only 且跨房隔離', () => {
  test('兩房各自成形；切斷中央 signaling 後仍各自雙向收發，且永不跨房 @vue-stable', async ({ browser }) => {
    test.setTimeout(360_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);
    const dave = await setupUser(browser);

    try {
      // 房 A 先成形，保持連線；再建立完全不同成員組成的房 B。
      const roomA = await createRoom(alice.page);
      await joinRoom(bob.page, roomA);
      await Promise.all([expectMeshReady(alice.page), expectMeshReady(bob.page)]);

      const roomB = await createRoom(carol.page);
      await joinRoom(dave.page, roomB);
      expect(roomB, '兩組 client 必須位於不同 roomId').not.toBe(roomA);
      await Promise.all([expectMeshReady(carol.page), expectMeshReady(dave.page)]);

      // 此刻兩個 mesh 同時存活，而非先後重用同一個網路。
      await Promise.all([
        expectMeshReady(alice.page),
        expectMeshReady(bob.page),
        expectMeshReady(carol.page),
        expectMeshReady(dave.page),
      ]);

      // bootstrap 尚在線時先立隔離哨兵：同房必達，另一房兩端都不得渲染。
      const roomAIsolation = uniqueMessage('room-A-isolation');
      const roomBIsolation = uniqueMessage('room-B-isolation');
      await sendMessage(alice.page, roomAIsolation);
      await expectExactlyOnce(alice.page, roomAIsolation, DELIVERY_TIMEOUT_MS);
      await expectExactlyOnce(bob.page, roomAIsolation, DELIVERY_TIMEOUT_MS);
      await sendMessage(carol.page, roomBIsolation);
      await expectExactlyOnce(carol.page, roomBIsolation, DELIVERY_TIMEOUT_MS);
      await expectExactlyOnce(dave.page, roomBIsolation, DELIVERY_TIMEOUT_MS);

      await alice.page.waitForTimeout(ISOLATION_SETTLE_MS);
      await Promise.all([
        expectAbsent(carol.page, roomAIsolation, 'Carol（房 B）'),
        expectAbsent(dave.page, roomAIsolation, 'Dave（房 B）'),
        expectAbsent(alice.page, roomBIsolation, 'Alice（房 A）'),
        expectAbsent(bob.page, roomBIsolation, 'Bob（房 A）'),
      ]);

      // bootstrap 已完成：四個獨立 client 都切斷中央 Firestore signaling/fallback。
      await Promise.all(
        [alice.page, bob.page, carol.page, dave.page].map((page) => cutCentralSignaling(page))
      );
      await Promise.all(
        [alice.page, bob.page, carol.page, dave.page].map((page) =>
          expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 10_000 })
        )
      );

      // 每個房間都在中央已斷後做雙向新訊息；收端送達才能證明不是本地樂觀渲染。
      const afterCut = [
        {
          sender: alice.page,
          members: [alice.page, bob.page],
          outsiders: [carol.page, dave.page],
          text: uniqueMessage('room-A-after-cut-from-Alice'),
          outsiderNames: ['Carol（房 B）', 'Dave（房 B）'],
        },
        {
          sender: bob.page,
          members: [alice.page, bob.page],
          outsiders: [carol.page, dave.page],
          text: uniqueMessage('room-A-after-cut-from-Bob'),
          outsiderNames: ['Carol（房 B）', 'Dave（房 B）'],
        },
        {
          sender: carol.page,
          members: [carol.page, dave.page],
          outsiders: [alice.page, bob.page],
          text: uniqueMessage('room-B-after-cut-from-Carol'),
          outsiderNames: ['Alice（房 A）', 'Bob（房 A）'],
        },
        {
          sender: dave.page,
          members: [carol.page, dave.page],
          outsiders: [alice.page, bob.page],
          text: uniqueMessage('room-B-after-cut-from-Dave'),
          outsiderNames: ['Alice（房 A）', 'Bob（房 A）'],
        },
      ];

      for (const probe of afterCut) {
        await sendMessage(probe.sender, probe.text);
        for (const member of probe.members) {
          await expectExactlyOnce(member, probe.text, DELIVERY_TIMEOUT_MS);
        }
      }

      // 再給 gossip／anti-entropy 一個完整沉澱窗，防止跨房漏訊因延遲而誤綠。
      await alice.page.waitForTimeout(ISOLATION_SETTLE_MS);
      for (const probe of afterCut) {
        await Promise.all(
          probe.outsiders.map((outsider, index) =>
            expectAbsent(outsider, probe.text, probe.outsiderNames[index]!)
          )
        );
      }
    } finally {
      await teardown(alice, bob, carol, dave);
    }
  });
});
