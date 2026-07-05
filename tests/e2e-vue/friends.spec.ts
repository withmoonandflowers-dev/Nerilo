/**
 * 好友系統：好友碼加好友 → 接受 → 自動建 DM 聊天室 → 訊息互通。
 */
import { test, expect } from '@playwright/test';
import { setupUser, sendMessage, uniqueMessage, expectChatReady, teardown } from './_helpers/users';

test.describe('好友 × DM', () => {
  test('加好友、接受、DM 互通', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      // B 打開好友頁取得好友碼。必須等 user 就緒——就緒前顯示佔位符 '…'，
      // 太早讀會把邀請送到 '…' 而非真 uid（array-contains 永不命中）。
      await bob.page.goto('/friends');
      const codeEl = bob.page.locator('.friends__code-value');
      await expect(codeEl).not.toHaveText('…', { timeout: 15_000 });
      const bobCode = (await codeEl.textContent())?.trim();
      expect(bobCode, '好友碼應為 uid').toBeTruthy();
      expect(bobCode!.length, '好友碼應為完整 uid').toBeGreaterThan(10);

      // A 以 B 的好友碼送出邀請
      await alice.page.goto('/friends');
      await alice.page.getByLabel('好友碼輸入框').fill(bobCode!);
      await alice.page.getByRole('button', { name: '加好友' }).click();
      await expect(alice.page.getByText('已送出（等待對方接受）')).toBeVisible({ timeout: 10_000 });

      // B 收到邀請並接受 → 自動導向 DM 聊天室。
      // reload 一次再驗：Firestore emulator 的 Listen stream 對「首次出現的
      // 集合」偶發 transport error（真實 Firebase 即時推送無此問題），reload
      // 重新查詢可穩定驗證「資料確實已到 B」而非掩蓋即時性。
      await bob.page.reload();
      await expect(bob.page.getByText('待接受的邀請')).toBeVisible({ timeout: 15_000 });
      await bob.page.getByRole('button', { name: '接受' }).click();
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });

      // A 端好友列表出現、dashboard 有 DM 房；A 從好友列點進 DM
      await expect(alice.page.locator('.friend-row--link')).toBeVisible({ timeout: 15_000 });
      await alice.page.locator('.friend-row--link').click();
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });

      // DM 互通（星型 P2P）
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);
      const dm = uniqueMessage('dm');
      await sendMessage(alice.page, dm);
      await expect(bob.page.locator('.bubble').filter({ hasText: dm })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await teardown(alice, bob);
    }
  });
});
