/**
 * Spec 005 T6：p2p2p 自主連線——第三人經介紹加入，被介紹 pair 零 Firestore signaling。
 *
 * 劇本：A 建房、B 加入（Firestore bootstrap，這是頭兩人的物理必要）。B 發邀請連結
 * （fragment 內嵌會合資訊）給 C。C 開連結加入：
 *   - C↔B（介紹人 pair）＝Firestore 第一跳（Q7a，物理限制：素未謀面需要會合點）。
 *   - C↔A（被介紹 pair）＝**加密 peer 中繼**，SDP 經 B 轉發、全程零 Firestore 寫入。
 *
 * 證明鏈（console 文字，log 行由 WarmCold/SigRelayRouter 內插保證）：
 *   1. 介紹人 B 的 console 有「已中繼信封」→ 加密信封真的經 B 轉發。
 *   2. A 與 C 的 console 對 A↔C pair label **沒有**「退回 cold」→ 該 pair 從未寫
 *      Firestore（cold 首寫前必有此 log），卻連上了 → signaling 全程走 warm。
 *   3. B 或 C 對 B↔C pair label **有**「退回 cold」→ bootstrap 第一跳確實走 Firestore
 *      （誠實對照：不是整場都僥倖 warm，Strangler 三態如設計運作）。
 * 功能面：三人互發訊息各自可見（連線是真的通，不只是握手）。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, createRoom, joinRoom, sendMessage, uniqueMessage, teardown } from './_helpers/users';

const DELIVERY_TIMEOUT_MS = 30_000;

/** 與 src/core/p2p/InviteRendezvous.ts 相同的編碼（測試端自組邀請連結）。 */
function encodeRendezvous(room: string, inviterUid: string): string {
  const json = JSON.stringify({ v: 'nrz1', room, inviter: { uid: inviterUid } });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function collectConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (msg) => lines.push(msg.text()));
  return lines;
}

async function uidOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __nerilo_test__?: { auth?: { currentUser?: { uid?: string } } } };
    const uid = w.__nerilo_test__?.auth?.currentUser?.uid;
    if (!uid) throw new Error('test hook 無 auth uid');
    return uid;
  });
}

/** MeshConnection 的對稱 channelLabel（與 src/core/mesh/MeshConnection.ts 同式）。 */
const pairLabel = (u1: string, u2: string) => {
  const s = [u1, u2].sort();
  return `mesh-${s[0]}-${s[1]}`;
};

test.describe('Spec 005 p2p2p 介紹加入', () => {
  // 尚未掛 @vue-stable：機制已驗（見 spec 005 §5 T6 紀錄——C 側零 Firestore 寫入與
  // B 中繼加密信封有實錄），但三瀏覽器在 emulator 下的「全綠」尚未穩定重現
  // （C 進場時序×keyx×WebRTC 組合窗）。穩定連過 3 次再掛 stable。
  test('第三人經介紹加入：被介紹 pair 走加密中繼、零 Firestore signaling', async ({ browser }) => {
    test.setTimeout(300_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const logsA = collectConsole(alice.page);
      const logsB = collectConsole(bob.page);

      // ── 頭兩人：Firestore bootstrap（物理必要）──
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      for (const page of [alice.page, bob.page]) {
        await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
        await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 60_000 });
      }
      const aliceUid = await uidOf(alice.page);
      const bobUid = await uidOf(bob.page);

      // ── 第三人 C：開 B 的邀請連結（fragment 會合資訊）──
      const carol = await setupUser(browser);
      const logsC = collectConsole(carol.page);
      try {
        await carol.page.goto(`/waiting/${roomId}#nrz=${encodeRendezvous(roomId, bobUid)}`);
        await expect(carol.page).toHaveURL(/\/chat\/.+/, { timeout: 30_000 });
        const carolUid = await uidOf(carol.page);

        // 發訊前等三端全穩（對齊 mesh-diagnostic 慣例：C 進場觸發 re-key/拓撲擴張，
        // 立刻發訊會撞上換鑰窗）；再靜置讓 keyx 分發收斂。
        for (const page of [alice.page, bob.page, carol.page]) {
          await expect(page.locator('.chat__banner--info')).toBeVisible({ timeout: 90_000 });
          await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 90_000 });
        }
        await carol.page.waitForTimeout(5_000);

        // 功能證明：三人互發，各自可見（不只握手，資料真的流通）
        const msgs: Array<[Page, string]> = [
          [alice.page, uniqueMessage('intro-A')],
          [bob.page, uniqueMessage('intro-B')],
          [carol.page, uniqueMessage('intro-C')],
        ];
        for (const [page, text] of msgs) await sendMessage(page, text);
        for (const page of [alice.page, bob.page, carol.page]) {
          for (const [, text] of msgs) {
            await expect(page.locator('.bubble').filter({ hasText: text }).first()).toBeVisible({
              timeout: DELIVERY_TIMEOUT_MS,
            });
          }
        }

        const labelAC = pairLabel(aliceUid, carolUid);
        const labelBC = pairLabel(bobUid, carolUid);

        // 失敗診斷證據：選路/中繼相關 console 全文傾印到測試輸出
        for (const [name, lines] of [['A', logsA], ['B', logsB], ['C', logsC]] as const) {
          const hits = lines.filter((l) => /WarmCold|SigRelay|退回 cold|已中繼|耐心|rendezvous/.test(l));
          console.log(`[evidence:${name}]`, hits.length ? `\n${hits.join('\n')}` : '(none)');
        }

        // 1. 介紹人 B 真的中繼過加密信封
        expect(
          logsB.some((l) => l.includes('已中繼信封')),
          'B（介紹人）console 應有「已中繼信封」——加密 SDP 經它轉發'
        ).toBe(true);

        // 2. 被介紹 pair（A↔C）零 Firestore：兩側都沒有對此 label 的「退回 cold」
        const fellColdAC = [...logsA, ...logsC].filter(
          (l) => l.includes('退回 cold') && l.includes(labelAC)
        );
        expect(
          fellColdAC,
          'A↔C（被介紹 pair）不得退回 Firestore——warm 中繼應全程承載'
        ).toEqual([]);

        // 3. bootstrap pair（B↔C）誠實走了 Firestore 第一跳（Q7a 對照組）
        expect(
          [...logsB, ...logsC].some((l) => l.includes('退回 cold') && l.includes(labelBC)),
          'B↔C（bootstrap 第一跳）應退回 Firestore——素未謀面的物理限制'
        ).toBe(true);
      } finally {
        await teardown(carol);
      }
    } finally {
      await teardown(alice, bob);
    }
  });
});
