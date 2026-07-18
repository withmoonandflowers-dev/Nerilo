/**
 * Spec 010 遷移窗回歸鎖：第三人加入的同時三方連發，矩陣全 =1
 *
 * 這支測試把 React 版診斷測試（tests/e2e/mesh-diagnostic.spec.ts）刻意繞開的
 * 時窗直接納入斷言：React 產線 2 人星型 → 第 3 人加入切 mesh，切換窗內送出的
 * 訊息屬星型棧、mesh anti-entropy 管不到（無聲掉信，QA 已知限制）。Vue 線已依
 * ADR-0023 P2-③ 把 star 退役——2 人房從第一則訊息就走 gossip 複寫日誌，
 * store-first + anti-entropy 補送，設計上不存在「兩個棧」。本測試把這個免疫
 * 從設計主張釘成測試事實，並依 Spec 010（Q5a）掛進 ADR-0017 切換門檻。
 *
 * 劇本（對映 React 線的掉信窗）：
 * 1. A 建房、B 加入成 2 人房，互送基線訊息（React 線此階段＝星型時代）。
 * 2. C 加入；與 C 的加入「並發」，A、B 立即再送訊——不等 C 就緒、不等 mesh
 *    橫幅、不等「已連線」狀態（React 線的 W2/W3 掉信窗正是此刻）。
 * 3. C 進房後在頁面允許的第一時間送訊；送失敗就按「重新傳送」——fail-visible
 *    是 Vue 線明訂行為（送訊擲錯、標 failed、可重送），重送不破恰好一次
 *    （id 貫穿樂觀顯示/gossip/備援，收端以 id 去重）。
 *
 * 誠實條款（不准加長 timeout 硬湊綠）：
 * - 已連線 pair（A↔B）的送達 deadline 20s = 10 個 anti-entropy 週期，同
 *   mesh-diagnostic，固定不放寬。
 * - 涉及 C 的格子 deadline 60s：涵蓋 C 的 WebRTC/ICE 成形（模擬器下合法地
 *   需要 30-60s，同既有套件的連線成形語義）——這是連線成形時間，不是放寬
 *   對帳時限；可靠性主張完全落在 count==1。
 * - 斷言前固定沉澱 5s，給「重複」浮現的機會。
 * - C 對 2 人時代歷史（m1/m2）的可見性只記錄不斷言：新成員歷史補齊是獨立
 *   語義（anti-entropy 覆蓋、rejoin.spec 鎖類似路徑），不屬遷移窗。
 * - 與 C 加入「並發」的訊息（msgA/msgB）對 C 可見與否不斷言（2026-07-18 使用者
 *   拍板，四線合併裁決）：這些訊息可能以 C 未受封的房間金鑰 epoch 加密——012 出口閘
 *   關閉形成期明文窗後，「新人不解加入前內容」是已鎖密碼學語義
 *   （MeshKeyxIntegration.spec），與 009「舊代不補」同一安全取向。本測試的可靠性
 *   主張收斂為：既有成員（A、B）之間任何時窗的訊息恆恰好一次、C 加入後的訊息
 *   （msgC）全員恰好一次——「不重不漏」對既有成員成立，C 的並發窗可見性讓位給
 *   保密語義。若 C 收到（明文窗仍開／同 epoch），仍斷言不得重複。
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

const DELIVERY_TIMEOUT_MS = 20_000; // 已連線 pair：10 個對帳週期，固定
const JOIN_WINDOW_TIMEOUT_MS = 60_000; // 涉及 C：含 ICE 成形（見檔頭誠實條款）
const DUP_SETTLE_MS = 5_000;

/**
 * 送訊，若標「傳送失敗」則按「重新傳送」直到送出（fail-visible + 重送是
 * 產品明訂行為；C 在 mesh 服務就緒前送訊會走此路徑）。
 */
async function sendWithRetry(page: Page, text: string): Promise<void> {
  await sendMessage(page, text);
  const retryBtn = page
    .locator('.msg-row')
    .filter({ hasText: text })
    .locator('.msg-status__retry');
  for (let i = 0; i < 20; i++) {
    let visible = false;
    try {
      await retryBtn.waitFor({ state: 'visible', timeout: 2_000 });
      visible = true;
    } catch {
      /* 沒有 retry 鈕 → 已送出（或仍在 sending） */
    }
    if (!visible) return;
    await retryBtn.click();
    await page.waitForTimeout(1_000);
  }
  throw new Error(`重送多次仍失敗：${text}`);
}

test.describe('Spec 010 遷移窗（Vue 線無星型棧）', () => {
  test('第三人加入的同時三方連發，每格恰好一次 @vue-stable', async ({ browser }) => {
    test.setTimeout(240_000);

    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);

    try {
      // ── 階段 1：2 人房基線（React 線的「星型時代」）──
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      const m1 = uniqueMessage('mwin-pre-A');
      const m2 = uniqueMessage('mwin-pre-B');
      await sendMessage(alice.page, m1);
      await sendMessage(bob.page, m2);
      for (const page of [alice.page, bob.page]) {
        for (const text of [m1, m2]) {
          await expect(page.locator('.bubble').filter({ hasText: text }).first()).toBeVisible({
            timeout: DELIVERY_TIMEOUT_MS,
          });
        }
      }

      // ── 階段 2：C 加入；A、B 與之「並發」立即送訊（不等任何就緒訊號）──
      const msgA = uniqueMessage('mwin-A');
      const msgB = uniqueMessage('mwin-B');
      await Promise.all([
        joinRoom(carol.page, roomId), // C 的加入進行中……
        sendMessage(alice.page, msgA), // ……A 同時送（React 線這裡掉信）
        sendMessage(bob.page, msgB), // ……B 同時送
      ]);

      // ── 階段 3：C 在頁面允許的第一時間送訊（失敗即重送，fail-visible）──
      const msgC = uniqueMessage('mwin-C');
      await expect(carol.page.getByLabel('訊息輸入框')).toBeVisible({ timeout: 20_000 });
      await sendWithRetry(carol.page, msgC);

      // ── 斷言：窗內 3 則 × 3 畫面矩陣全 =1；基線 2 則在 A、B 仍各 =1 ──
      const viewers: Array<[string, Page]> = [
        ['A', alice.page],
        ['B', bob.page],
        ['C', carol.page],
      ];
      const windowMsgs = [msgA, msgB, msgC];

      // 先等「必須送達」的格子（涉及 C 的格子含 ICE 成形時間）。
      // C×(msgA,msgB) 不在此列：並發訊息對 C 可見與否不斷言（見檔頭裁決）。
      for (const [name, page] of viewers) {
        for (const text of windowMsgs) {
          if (name === 'C' && text !== msgC) continue;
          const involvesCarol = name === 'C' || text === msgC;
          await expect(
            page.locator('.bubble').filter({ hasText: text }).first(),
            `${name} 應收到 ${text}`
          ).toBeVisible({
            timeout: involvesCarol ? JOIN_WINDOW_TIMEOUT_MS : DELIVERY_TIMEOUT_MS,
          });
        }
      }

      // 沉澱：讓潛在重複浮現
      await alice.page.waitForTimeout(DUP_SETTLE_MS);

      const matrix: string[] = [];
      for (const [name, page] of viewers) {
        const row: string[] = [];
        for (const text of windowMsgs) {
          row.push(String(await page.locator('.bubble').filter({ hasText: text }).count()));
        }
        matrix.push(`${name}: ${row.join(' ')}`);
      }
      // 診斷紀錄：C 對 2 人時代歷史的可見性（不斷言，見檔頭）
      const preOnC = [
        await carol.page.locator('.bubble').filter({ hasText: m1 }).count(),
        await carol.page.locator('.bubble').filter({ hasText: m2 }).count(),
      ];
      console.log(`=== Spec 010 遷移窗矩陣（C×並發格不斷言，見檔頭） ===\n${matrix.join('\n')}\nC 見基線歷史: ${preOnC.join(' ')}`);

      for (const [name, page] of viewers) {
        for (const text of windowMsgs) {
          if (name === 'C' && text !== msgC) {
            // 並發窗訊息對 C：0（未受封 epoch，保密語義）或 1（收到即不得重複）
            const n = await page.locator('.bubble').filter({ hasText: text }).count();
            expect(n, `C 畫面 ${text} 至多 1（不得重複）`).toBeLessThanOrEqual(1);
            continue;
          }
          await expect(
            page.locator('.bubble').filter({ hasText: text }),
            `${name} 畫面 ${text} 應恰好 1`
          ).toHaveCount(1);
        }
      }
      // 基線訊息未因 C 加入而重複或消失（A、B 畫面）
      for (const [name, page] of [viewers[0]!, viewers[1]!]) {
        for (const text of [m1, m2]) {
          await expect(
            page.locator('.bubble').filter({ hasText: text }),
            `${name} 畫面基線 ${text} 應恰好 1`
          ).toHaveCount(1);
        }
      }
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
