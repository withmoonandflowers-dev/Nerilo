/**
 * web-vue 7 人 mesh 診斷（Spec 011 分層證據的 E2E 層）：矩陣全 =1。
 *
 * 7 人 = 最小 partial mesh 規模（AdaptiveTopologyManager 第 7 人切
 * partial-mesh：k=3、fanout 3、ttl 3）。本測試同時涵蓋：
 * - 跨界劇本：成員逐一加入，房間自然經過 2→6（full mesh）→7（partial）邊界，
 *   已在場成員的頁面靠名冊 watch push 觸發「只升不降」升級。
 * - 多跳擴散 + anti-entropy：k=3 下訊息不再一跳全網，必須靠轉發與對帳補齊。
 * - 容量分層（Q7）：房主以 Pro claim 建 10 人房（Auth emulator 設 custom claim
 *   → 強制刷新 token → rules 依 token.plan 驗證 maxParticipants>5）。
 *
 * 誠實條款（沿用 3 人矩陣口徑，不放寬）：
 * - 每格送達 deadline 20s = 10 個對帳週期，固定。
 * - 斷言前沉澱 5s 抓重複。
 * - 總 timeout 只涵蓋 7 組註冊與 WebRTC 連線成形（模擬器下合法地慢）。
 *
 * 未標 @vue-stable：新測試需先累積本機/CI 觀察，證明穩定才進 stable 集
 * （對齊 CURRENT-STATUS 的觀察期紀律）。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  sendMessage,
  uniqueMessage,
  teardown,
  type User,
} from './_helpers/users';

const DELIVERY_TIMEOUT_MS = 20_000;
const DUP_SETTLE_MS = 5_000;
const AUTH_EMULATOR = 'http://127.0.0.1:9099';
const PROJECT_ID = 'nerilo';

/** 透過 Auth emulator 管理端點把使用者標成 Pro（token.plan='pro'），再強制刷新頁面內 token */
async function grantProPlan(page: Page): Promise<void> {
  const uid = await page.evaluate(
    () =>
      (window as unknown as { __nerilo_test__: { auth: { currentUser: { uid: string } } } })
        .__nerilo_test__.auth.currentUser.uid
  );
  const res = await fetch(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ plan: 'pro' }) }),
    }
  );
  if (!res.ok) throw new Error(`Auth emulator accounts:update failed: ${res.status}`);
  // 舊 token 不含 claim：強制刷新讓後續 createRoom 與 Firestore 請求帶上 plan=pro
  await page.evaluate(() =>
    (
      window as unknown as {
        __nerilo_test__: { auth: { currentUser: { getIdToken(force: boolean): Promise<string> } } };
      }
    ).__nerilo_test__.auth.currentUser.getIdToken(true)
  );
}

test.describe('Vue 版 7 人 mesh 診斷（partial mesh，Spec 011）', () => {
  test('每則訊息在 7 個畫面最終各恰好一次', async ({ browser }) => {
    test.setTimeout(600_000); // 7 組註冊 + 7 節點 WebRTC/ICE 成形；送達斷言仍是緊 deadline

    const users: User[] = [];
    try {
      // 房主：Pro 建 10 人房（rules 驗證 token.plan）
      const owner = await setupUser(browser);
      users.push(owner);
      await grantProPlan(owner.page);
      const roomId = await createRoom(owner.page);

      // 其餘 6 人逐一加入：房間自然跨過 6→7 的 full→partial 邊界
      for (let i = 1; i < 7; i++) {
        const u = await setupUser(browser);
        users.push(u);
        await joinRoom(u.page, roomId);
        await expect(u.page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
      }
      // 房主由 waiting 進 chat（第 2 人加入時房間轉 open）
      await joinRoom(owner.page, roomId);

      // 等 7 人都進 mesh 且 ≥1 鄰居連上；不等 full mesh（partial 下也不存在連滿 n-1）
      for (const u of users) {
        await expect(u.page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
        await expect(u.page.locator('.chat__banner--info')).toBeVisible({ timeout: 90_000 });
        await expect(u.page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 90_000 });
      }

      // 7 人接連發送：partial mesh（k=3）下部分 pair 無直連，靠轉發（ttl 3）與對帳
      const msgs: Array<[Page, string]> = users.map((u, i) => [
        u.page,
        uniqueMessage(`7p-${String.fromCharCode(65 + i)}`),
      ]);
      for (const [page, text] of msgs) await sendMessage(page, text);

      // 每格先等送達，再沉澱抓重複，最後 7×7 矩陣全 =1
      for (const u of users) {
        for (const [, text] of msgs) {
          await expect(u.page.locator('.bubble').filter({ hasText: text }).first()).toBeVisible({
            timeout: DELIVERY_TIMEOUT_MS,
          });
        }
      }
      await users[0]!.page.waitForTimeout(DUP_SETTLE_MS);

      const matrix: string[] = [];
      for (let v = 0; v < users.length; v++) {
        const row: string[] = [];
        for (const [, text] of msgs) {
          row.push(String(await users[v]!.page.locator('.bubble').filter({ hasText: text }).count()));
        }
        matrix.push(`${String.fromCharCode(65 + v)}: ${row.join(' ')}`);
      }
      console.log('=== 7 人送達矩陣 ===\n' + matrix.join('\n'));

      for (let v = 0; v < users.length; v++) {
        for (const [, text] of msgs) {
          await expect(
            users[v]!.page.locator('.bubble').filter({ hasText: text }),
            `${String.fromCharCode(65 + v)} 畫面矩陣格應恰好 1`
          ).toHaveCount(1);
        }
      }
    } finally {
      await teardown(...users);
    }
  });
});
