/**
 * Spec 012 Q7 出口 (ii)：Firestore 備援／橋接文件必為密文。
 *
 * 劇本：2 人房 keyx 完成後，B 離開畫面（仍是 participant）→ A 續發訊息 →
 * 覆蓋不足觸發加密橋接（房間金鑰）。直接以 Firestore emulator REST 讀該房
 * messages collection 的「伺服器端真實位元組」斷言：
 *  1. 每份文件都有 encrypted 欄位、沒有明文 content 欄位。
 *  2. 文件 JSON 不含任何送出過的明文字串。
 * 之後 B 重進房，橋接訊息以明文恰好一次呈現（解密路徑端到端活著）。
 */
import { test, expect } from '@playwright/test';
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

const FIRESTORE_REST = 'http://127.0.0.1:8080/v1/projects/nerilo/databases/(default)/documents';

interface FirestoreDoc {
  name: string;
  fields?: Record<string, unknown>;
}

/** 以 emulator REST 讀該房全部 message 文件（owner bypass；只在 emulator 有效）。 */
async function readMessageDocs(roomId: string): Promise<FirestoreDoc[]> {
  const res = await fetch(`${FIRESTORE_REST}/p2pRooms/${roomId}/messages?pageSize=100`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!res.ok) throw new Error(`firestore REST ${res.status}`);
  const body = (await res.json()) as { documents?: FirestoreDoc[] };
  return body.documents ?? [];
}

test.describe('Vue 版 Firestore 備援密文（Spec 012）', () => {
  test('B 離場後的橋接訊息：伺服器只見密文；B 重進以明文恰好一次呈現', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await setupUser(browser);
    const bob = await setupUser(browser);
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page);
      await expectChatReady(bob.page);

      // 等 keyx 完成（指示器真值到 encrypted）→ 出口閘放行、橋接必有金鑰可用
      await expect(alice.page.getByTestId('e2ee-encrypted')).toBeVisible({ timeout: 60_000 });

      // 健康基線：全覆蓋時送訊走 gossip，不寫 Firestore
      const m1 = uniqueMessage('covered');
      await sendMessage(alice.page, m1);
      await expectExactlyOnce(bob.page, m1);

      // B 離開畫面（返回 dashboard；仍是 participant → A 的覆蓋不足）
      await bob.page.getByRole('button', { name: '離開房間' }).click();
      await expect(bob.page).toHaveURL(/\/dashboard/, { timeout: 10_000 });

      // A 續發直到橋接觸發（覆蓋偵測靠 heartbeat，數秒級；每輪發新訊息再查 REST）
      const bridged: string[] = [];
      await expect
        .poll(
          async () => {
            const m = uniqueMessage('bridged');
            bridged.push(m);
            await sendMessage(alice.page, m);
            return (await readMessageDocs(roomId)).length;
          },
          { timeout: 90_000, intervals: [4_000], message: '橋接應在覆蓋不足後寫入 Firestore' }
        )
        .toBeGreaterThan(0);

      // 伺服器端真實位元組：全部密文、零明文欄位、零明文子字串
      const docs = await readMessageDocs(roomId);
      const rawJson = JSON.stringify(docs);
      for (const doc of docs) {
        expect(doc.fields?.encrypted, `${doc.name} 應有 encrypted 欄位`).toBeTruthy();
        expect(doc.fields?.content, `${doc.name} 不得有明文 content 欄位`).toBeUndefined();
      }
      for (const plain of [m1, ...bridged]) {
        expect(rawJson).not.toContain(plain);
      }

      // B 重進：橋接訊息（或 anti-entropy 補齊）以明文恰好一次呈現
      await bob.page.locator('.room-row').first().click();
      await expect(bob.page).toHaveURL(/\/chat\/.+/, { timeout: 10_000 });
      await expectExactlyOnce(bob.page, bridged[bridged.length - 1]!, 30_000);
    } finally {
      await teardown(alice, bob);
    }
  });
});
