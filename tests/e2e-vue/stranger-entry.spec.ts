/**
 * Spec 030 階段 B 的陌生人入場回歸鎖。
 *
 * 介紹路徑是 characterization：現況本來就不檢查 ownerUid，真正條件是介紹人已在
 * 房籍內，且有直連、已開啟的暖鄰居 link。本輪沒有新增這項產品能力。
 * 私有房案例只驗 T-003 與 Vue R11 的持連結 self-join，不宣稱 nintro1 已強制授權。
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  createRoom,
  expectChatReady,
  expectExactlyOnce,
  sendMessage,
  setupUser,
  teardown,
  uniqueMessage,
} from './_helpers/users';

function encodeRendezvous(room: string, inviterUid: string): string {
  const json = JSON.stringify({ v: 'nrz1', room, inviter: { uid: inviterUid } });
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function uidOf(page: Page): Promise<string> {
  const uid = await page.evaluate(() => {
    const hook = (window as unknown as {
      __nerilo_test__?: { auth?: { currentUser?: { uid?: string } | null } };
    }).__nerilo_test__;
    return hook?.auth?.currentUser?.uid ?? null;
  });
  if (!uid) throw new Error('test hook auth uid 不可用');
  return uid;
}

async function assertMessageVisibleToAll(pages: Page[], prefix: string): Promise<void> {
  // 連線橫幅只代表拓撲可用。產品在房間金鑰未就緒時會拒絕明文降級，
  // 所以送出前必須確認每個 context 都已進入 encrypted 狀態。
  for (const page of pages) {
    await expect(page.getByTestId('e2ee-encrypted')).toBeVisible({ timeout: 90_000 });
  }
  const message = uniqueMessage(prefix);
  await sendMessage(pages.at(-1)!, message);
  for (const page of pages) await expectExactlyOnce(page, message, 30_000);
}

async function linkedEntry(browser: Browser, privateRoom: boolean): Promise<void> {
  const alice = await setupUser(browser);
  const bob = await setupUser(browser);
  try {
    const roomId = await createRoom(alice.page, { privateRoom });
    // 素 waiting URL 代表目錄／連結路徑，沒有 nrz introducer hint。
    await bob.page.goto(`/waiting/${roomId}`);
    await expectChatReady(alice.page, 60_000);
    await expectChatReady(bob.page, 60_000);
    await assertMessageVisibleToAll([alice.page, bob.page], privateRoom ? 'private-directory' : 'public-directory');
  } finally {
    await teardown(alice, bob);
  }
}

async function nonOwnerIntroduction(browser: Browser, privateRoom: boolean): Promise<void> {
  const alice = await setupUser(browser);
  const bob = await setupUser(browser);
  const carol = await setupUser(browser);
  try {
    const roomId = await createRoom(alice.page, { privateRoom });
    await bob.page.goto(`/waiting/${roomId}`);
    await expectChatReady(alice.page, 60_000);
    await expectChatReady(bob.page, 60_000);

    const aliceUid = await uidOf(alice.page);
    const bobUid = await uidOf(bob.page);
    expect(bobUid, '介紹人必須是非房主的既有成員').not.toBe(aliceUid);

    const bobLogs: string[] = [];
    bob.page.on('console', (message) => bobLogs.push(message.text()));
    await carol.page.goto(`/waiting/${roomId}#nrz=${encodeRendezvous(roomId, bobUid)}`);

    for (const page of [alice.page, bob.page, carol.page]) {
      await expectChatReady(page, 90_000);
    }
    await assertMessageVisibleToAll(
      [alice.page, bob.page, carol.page],
      privateRoom ? 'private-introduction' : 'public-introduction'
    );
    await expect.poll(
      () => bobLogs.some((line) => line.includes('已中繼信封')),
      { timeout: 30_000, message: '非房主介紹人的 console 應留下加密信封中繼證據' }
    ).toBe(true);
  } finally {
    await teardown(alice, bob, carol);
  }
}

test.describe('Spec 030 陌生人入場 @stranger', () => {
  test('目錄／素連結讓陌生人進入公開房', async ({ browser }) => {
    test.setTimeout(180_000);
    await linkedEntry(browser, false);
  });

  test('目錄／素連結讓陌生人進入私有房（Vue R11）', async ({ browser }) => {
    test.setTimeout(180_000);
    await linkedEntry(browser, true);
  });

  test('非房主的既有成員介紹陌生人進入公開房', async ({ browser }) => {
    test.setTimeout(300_000);
    await nonOwnerIntroduction(browser, false);
  });

  test('非房主的既有成員介紹陌生人進入私有房（Vue R11）', async ({ browser }) => {
    test.setTimeout(300_000);
    await nonOwnerIntroduction(browser, true);
  });
});
