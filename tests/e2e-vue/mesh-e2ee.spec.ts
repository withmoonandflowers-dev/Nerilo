/**
 * ADR-0023 P2-②c：3 人 mesh 房端到端加密驗收（Vue 接線）。
 *
 * 斷言兩件事同時成立：
 *  1. UI 顯示明文（每則訊息在每個畫面恰好一次，如同 mesh-diagnostic）。
 *  2. 落地複本（IndexedDB 'NeriloReplica'）上，聊天紀錄 content 是密文信封（nrec1），
 *     不含明文——這正是「盲信使/中繼/Firestore 備援會存到的位元組」：持有者無房間金鑰
 *     即讀不出內容。keyx 分發紀錄同樣是不透明密文（成對 ECDH 封裝）。
 *
 * 讀 replica 前先等 keyx 傳播到每一頁（該頁 replica 出現 channel:'keyx' 紀錄 = 已消費、
 * 金鑰已入環）→ 確保送訊時所有寄件端都已持鑰、聊天紀錄必為密文，避免形成期空窗誤判。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  setupUser,
  createRoom,
  joinRoom,
  sendMessage,
  uniqueMessage,
  teardown,
} from './_helpers/users';

const DELIVERY_TIMEOUT_MS = 20_000;
const KEYX_TIMEOUT_MS = 40_000;

/** 讀該頁 'NeriloReplica' 的所有紀錄，parse 出 { channel, content } 陣列 */
async function readReplicaRecords(
  page: Page
): Promise<Array<{ channel: string | undefined; content: string }>> {
  return page.evaluate(async () => {
    const rows: Array<{ recordJson: string }> = await new Promise((resolve, reject) => {
      const req = indexedDB.open('NeriloReplica');
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('records', 'readonly');
          const all = tx.objectStore('records').getAll();
          all.onsuccess = () => resolve(all.result as Array<{ recordJson: string }>);
          all.onerror = () => reject(all.error);
        } catch (e) {
          reject(e);
        }
      };
      req.onerror = () => reject(req.error);
    });
    return rows.map((r) => {
      try {
        const m = JSON.parse(r.recordJson) as { channel?: string; content: string };
        return { channel: m.channel, content: m.content };
      } catch {
        return { channel: undefined, content: '' };
      }
    });
  });
}

async function waitForKeyxPropagated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => (await readReplicaRecords(page)).some((r) => r.channel === 'keyx'),
      { timeout: KEYX_TIMEOUT_MS, message: 'keyx 紀錄應傳播到此頁的複本（金鑰已就緒）' }
    )
    .toBe(true);
}

test.describe('Vue 版 3 人 mesh 端到端加密（P2-②c）', () => {
  test('UI 明文、複本密文（盲信使存到的是不可解密文）', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    const carol = await setupUser(browser);
    const pages = [alice.page, bob.page, carol.page];
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await joinRoom(carol.page, roomId);

      for (const page of pages) {
        await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
        await expect(page.locator('.chat__banner--info')).toBeVisible({ timeout: 60_000 });
        await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: 60_000 });
      }

      // 等 keyx 傳播到每一頁 → 全員持鑰後才送訊（保證聊天紀錄必為密文）
      for (const page of pages) await waitForKeyxPropagated(page);

      const msgs: Array<[Page, string]> = [
        [alice.page, uniqueMessage('e2ee-A')],
        [bob.page, uniqueMessage('e2ee-B')],
        [carol.page, uniqueMessage('e2ee-C')],
      ];
      for (const [page, text] of msgs) await sendMessage(page, text);

      // (1) UI：每則在每個畫面恰好一次的明文
      for (const page of pages) {
        for (const [, text] of msgs) {
          await expect(
            page.locator('.bubble').filter({ hasText: text }).first()
          ).toBeVisible({ timeout: DELIVERY_TIMEOUT_MS });
        }
      }
      for (const page of pages) {
        for (const [, text] of msgs) {
          await expect(page.locator('.bubble').filter({ hasText: text })).toHaveCount(1);
        }
      }

      // (2) 複本：聊天紀錄是密文（nrec1）、不含明文；keyx 是不透明封裝
      const plaintexts = msgs.map(([, t]) => t);
      for (const page of pages) {
        const records = await readReplicaRecords(page);
        const chatRecords = records.filter((r) => r.channel === undefined || r.channel === 'chat');
        // 三則聊天紀錄都應已補齊到每個複本
        expect(chatRecords.length).toBeGreaterThanOrEqual(3);
        for (const rec of chatRecords) {
          expect(rec.content).toContain('"v":"nrec1"'); // 密文信封標記
          for (const pt of plaintexts) {
            expect(rec.content).not.toContain(pt); // 明文不外洩到落地位元組
          }
        }
        // keyx 紀錄存在且不含任何明文（成對 ECDH 封裝的不透明密文）
        const keyxRecords = records.filter((r) => r.channel === 'keyx');
        expect(keyxRecords.length).toBeGreaterThanOrEqual(1);
        for (const rec of keyxRecords) {
          for (const pt of plaintexts) expect(rec.content).not.toContain(pt);
        }
      }
    } finally {
      await teardown(alice, bob, carol);
    }
  });
});
