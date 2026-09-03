import { expect, test } from '@playwright/test';

test('單人等待、兩人加密連線與訊息互通', async ({ browser }) => {
  const room = `e2e-${Date.now()}`;
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();

  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.goto(`/?room=${room}`);
    await expect(alice.locator('#status')).toHaveText(
      '房裡目前只有你。請第二台裝置開同一個網址加入，才會開始連線。',
    );

    await alice.locator('#name').fill('Alice');
    await alice.locator('#name').dispatchEvent('change');
    await bob.goto(`/?room=${room}`);
    await bob.locator('#name').fill('Bob');
    await bob.locator('#name').dispatchEvent('change');

    const connected = /已連線（P2P 直連＋端到端加密，房內 2 人）/;
    await expect(alice.locator('#status')).toHaveText(connected, { timeout: 60_000 });
    await expect(bob.locator('#status')).toHaveText(connected, { timeout: 60_000 });

    const message = `rendezvous-${Date.now()}`;
    await alice.locator('#input').fill(message);
    await alice.locator('#send').click();

    await expect(bob.locator('.msg').filter({ hasText: message })).toHaveCount(1, { timeout: 30_000 });
    await expect(bob.locator('.msg').filter({ hasText: message }).locator('b')).toHaveText('Alice');
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
