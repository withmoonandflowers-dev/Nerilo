/**
 * 3 人 mesh 診斷：訊息「最終各恰好一次」（exactly-once 呈現）
 *
 * 驗證標準：3x3 送達矩陣（3 則訊息 × 3 個畫面）每格恰好 1。
 * count==1 同時抓「漏」（0）與「重」（≥2），是比 visible 更強的斷言。
 *
 * 誠實條款（不准加長 timeout 硬湊綠）：
 * - 送達 deadline 每格 20s = 10 個 anti-entropy 週期（2s/輪），固定不放寬。
 * - 斷言 count 前固定沉澱 5s，給「重複」浮現的機會——這是加嚴不是放水。
 * - 總 test timeout 240s 只涵蓋帳號註冊與 WebRTC/ICE 連線成形（模擬器下
 *   合法地需要 30-60s），可靠性主張完全落在上面兩個數字。
 *
 * 補償不 gating：發送前只等兩個「模式訊號」，不等 full mesh 連滿——
 * - `.e2ee-indicator-dtls`：頁面已切到 mesh 拓撲。房主的頁面在第 2 人加入時
 *   會先以 2 人星型啟動、第 3 人加入才切 mesh；星型時代送出的訊息屬於另一個
 *   傳輸棧，mesh 對帳管不到（實測會在切換重載時重複或遺失——遷移窗問題，
 *   Spec 010 拍板：React 線不修、記誠實邊界，由 Vue 切 production 退役星型棧
 *   收斂；Vue 線的回歸鎖在 tests/e2e-vue/migration-window.spec.ts，該測試把
 *   這裡刻意繞開的時窗直接納入斷言）。本診斷驗的是 mesh 的保證，gating 保留。
 * - banner 已連線：mesh 下代表「連上至少 1 個鄰居」，不是全部。
 * 因此發送當下 pairwise DataChannel 常常尚未全就緒（例如 A–C 未通），訊息
 * 必須靠 seq-based anti-entropy 對帳（digest 交換 → 缺哪則補哪則）走任何
 * 已通的路徑補到位——這正是要驗證的補償機制，而非連線就緒 gating。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  uniqueMessage,
  teardown,
} from './_helpers/users';

const DELIVERY_TIMEOUT_MS = 20_000; // 10 個對帳週期；固定，不得放寬
const DUP_SETTLE_MS = 5_000; // 沉澱期：讓潛在重複有時間浮現

test.describe('3 人 mesh 診斷（矩陣全 =1）', () => {
  test('每則訊息在每個畫面最終各恰好一次', async ({ browser }) => {
    test.setTimeout(240_000); // 只為 3 組註冊 + WebRTC 連線成形；見檔頭誠實條款

    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);

    // 只轉錄 error/warning，作為失敗時的診斷證據
    const label: Array<[Page, string]> = [
      [alice.page, 'A'],
      [bob.page, 'B'],
      [carol.page, 'C'],
    ];
    const INTERESTING =
      /ChatPage|useMeshTopology|MeshChat|MeshGossip|GossipMessageHandler|MeshConnection|MeshTopologyManager|architecture|Migrating|topology|NERILO/;
    for (const [page, name] of label) {
      page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        // error/warning 全轉錄；info/log 只轉錄 mesh 相關（失敗時的時序證據）
        if (type === 'error' || type === 'warning' || INTERESTING.test(text)) {
          console.log(`[${name}]`, type, text);
        }
      });
    }

    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);

      // 等「進 mesh 模式 + 連上至少 1 個鄰居」——不等 full mesh 連滿（見檔頭）
      for (const [page] of [
        [alice.page],
        [bob.page],
        [carol.page],
      ] as Array<[Page]>) {
        await expect(page.locator('.e2ee-indicator-dtls')).toBeVisible({ timeout: 60_000 });
        await expectChatReady(page, 60_000);
      }

      // 三人立刻接連發送：此刻部分 pairwise 連線通常尚未成形，靠對帳補
      const msgA = uniqueMessage('diag-A');
      await sendMessage(alice.page, msgA);
      const msgB = uniqueMessage('diag-B');
      await sendMessage(bob.page, msgB);
      const msgC = uniqueMessage('diag-C');
      await sendMessage(carol.page, msgC);

      const pages: Array<[string, Page]> = [
        ['A', alice.page],
        ['B', bob.page],
        ['C', carol.page],
      ];
      const messages: Array<[string, string]> = [
        ['msgA', msgA],
        ['msgB', msgB],
        ['msgC', msgC],
      ];

      // 第一步：每格先等到「至少一次」送達（deadline 固定 20s）
      for (const [, page] of pages) {
        for (const [, text] of messages) {
          await expect(
            page.locator('.message-content').filter({ hasText: text }).first(),
          ).toBeVisible({ timeout: DELIVERY_TIMEOUT_MS });
        }
      }

      // 第二步：固定沉澱，讓遲到的重複遞送（若有）浮現
      await alice.page.waitForTimeout(DUP_SETTLE_MS);

      // 第三步：矩陣採樣 + 全 =1 斷言
      const matrix: string[] = [];
      for (const [viewer, page] of pages) {
        const row: string[] = [];
        for (const [msgName, text] of messages) {
          const count = await page.locator('.message-content').filter({ hasText: text }).count();
          row.push(`${msgName}=${count}`);
        }
        matrix.push(`${viewer} 看到: ${row.join(' ')}`);
      }
      console.log('=== 送達矩陣 ===\n' + matrix.join('\n'));

      for (const [viewer, page] of pages) {
        for (const [msgName, text] of messages) {
          await expect(
            page.locator('.message-content').filter({ hasText: text }),
            `${viewer} 畫面上的 ${msgName} 應恰好一次`,
          ).toHaveCount(1);
        }
      }
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
