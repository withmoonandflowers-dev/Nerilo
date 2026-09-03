/**
 * Vue candidate preview smoke.
 *
 * S1 proves the ordinary encrypted path, S2 proves a selected TURN relay pair,
 * and S3 proves that a WebRTC failure is shown honestly instead of displaying
 * a false encrypted state. The Playwright config refuses the production hosts.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as crypto from 'node:crypto';

type RtcMode = 'observe' | 'force-relay' | 'disable';

interface SmokeUser {
  ctx: BrowserContext;
  page: Page;
}

interface PcStats {
  connectionState: string;
  local: string | null;
  remote: string | null;
  rttMs: number | null;
}

function rtcInitScript(mode: RtcMode): string {
  return `
    (() => {
      window.__pcs = [];
      const Orig = window.RTCPeerConnection;
      if (${JSON.stringify(mode)} === 'disable') {
        window.RTCPeerConnection = function () {
          throw new Error('WebRTC disabled by Vue smoke test');
        };
        return;
      }
      function Patched(cfg = {}, ...rest) {
        const merged = ${JSON.stringify(mode)} === 'force-relay'
          ? { ...cfg, iceTransportPolicy: 'relay' }
          : cfg;
        const pc = new Orig(merged, ...rest);
        window.__pcs.push(pc);
        return pc;
      }
      Patched.prototype = Orig.prototype;
      Object.setPrototypeOf(Patched, Orig);
      window.RTCPeerConnection = Patched;
    })();
  `;
}

async function collectPcStats(page: Page): Promise<PcStats[]> {
  return page.evaluate(async () => {
    type AnyRec = Record<string, unknown>;
    const out: PcStats[] = [];
    const pcs = ((window as unknown as AnyRec).__pcs as RTCPeerConnection[]) || [];

    for (const pc of pcs) {
      try {
        const stats = await pc.getStats();
        const byId = new Map<string, AnyRec>();
        stats.forEach((row) => byId.set((row as AnyRec).id as string, row as AnyRec));
        let pair: AnyRec | null = null;

        stats.forEach((row) => {
          const rec = row as AnyRec;
          if (rec.type === 'candidate-pair' && rec.state === 'succeeded' && (rec.nominated || rec.selected)) {
            pair = rec;
          }
        });
        if (!pair) {
          stats.forEach((row) => {
            const rec = row as AnyRec;
            if (rec.type === 'transport' && rec.selectedCandidatePairId) {
              pair = byId.get(rec.selectedCandidatePairId as string) ?? null;
            }
          });
        }

        if (!pair) {
          out.push({ connectionState: pc.connectionState, local: null, remote: null, rttMs: null });
          continue;
        }

        const selected = pair as AnyRec;
        const local = byId.get(selected.localCandidateId as string);
        const remote = byId.get(selected.remoteCandidateId as string);
        out.push({
          connectionState: pc.connectionState,
          local: (local?.candidateType as string) ?? null,
          remote: (remote?.candidateType as string) ?? null,
          rttMs:
            typeof selected.currentRoundTripTime === 'number'
              ? Math.round((selected.currentRoundTripTime as number) * 1000)
              : null,
        });
      } catch {
        out.push({ connectionState: 'stats-error', local: null, remote: null, rttMs: null });
      }
    }

    return out;
  });
}

function freshAccount(tag: string): { email: string; password: string } {
  return {
    email: `vue-smoke-${tag}-${crypto.randomBytes(5).toString('hex')}@nerilo-smoke.test`,
    password: `Sm0ke-${crypto.randomBytes(9).toString('base64url')}`,
  };
}

async function registerFresh(page: Page, tag: string): Promise<void> {
  const account = freshAccount(tag);
  await page.goto('/login');
  await page.getByRole('button', { name: '使用 Email 登入' }).click();
  await page.getByRole('button', { name: '沒有帳號？註冊' }).click();
  await page.getByPlaceholder('Email').fill(account.email);
  await page.getByPlaceholder('密碼').fill(account.password);
  await page.getByRole('button', { name: '註冊', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: '建立或加入房間' })).toBeVisible({ timeout: 10_000 });
}

async function setupUser(browser: Browser, tag: string, mode: RtcMode): Promise<SmokeUser> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(rtcInitScript(mode));
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /NERILO|MeshChatService|IceServerProvider/.test(msg.text())) {
      console.log(`[${tag}] ${msg.type()}: ${msg.text()}`);
    }
  });
  await registerFresh(page, tag);
  return { ctx, page };
}

async function closeUsers(...users: SmokeUser[]): Promise<void> {
  for (const user of users) {
    await user.ctx.close().catch(() => {});
  }
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: '建立或加入房間' }).click();
  await page.getByPlaceholder('房間名稱（選填）').fill(name);
  await page.locator('.sheet__form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/waiting\/.+/, { timeout: 20_000 });
  const roomId = page.url().match(/\/waiting\/([^/?#]+)/)?.[1];
  if (!roomId) throw new Error('Could not extract roomId from waiting URL');
  return roomId;
}

async function joinRoom(page: Page, roomId: string): Promise<void> {
  await page.goto(`/chat/${roomId}`);
}

async function expectEncrypted(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(page.locator('.chat__status')).toHaveText(/已連線/, { timeout: timeoutMs });
  await expect(page.getByTestId('e2ee-encrypted')).toBeVisible({ timeout: timeoutMs });
}

async function sendAndExpectExactlyOnce(from: Page, to: Page, text: string): Promise<void> {
  const input = from.getByLabel('訊息輸入框');
  await input.fill(text);
  await from.getByRole('button', { name: '傳送', exact: true }).click();
  await expect(input).toHaveValue('', { timeout: 5_000 });
  const bubble = to.locator('.bubble').filter({ hasText: text });
  await expect(bubble.first()).toBeVisible({ timeout: 20_000 });
  await expect(bubble).toHaveCount(1);
}

test.describe('Vue preview smoke', () => {
  test('S1 direct: encrypted bidirectional messaging is exactly once', async ({ browser }) => {
    const alice = await setupUser(browser, 'direct-a', 'observe');
    const bob = await setupUser(browser, 'direct-b', 'observe');
    try {
      const roomId = await createRoom(alice.page, `Smoke direct ${Date.now()}`);
      await joinRoom(bob.page, roomId);
      await expectEncrypted(alice.page, 90_000);
      await expectEncrypted(bob.page, 90_000);

      const aToB = `S1 A→B ${crypto.randomUUID()}`;
      const bToA = `S1 B→A ${crypto.randomUUID()}`;
      await sendAndExpectExactlyOnce(alice.page, bob.page, aToB);
      await sendAndExpectExactlyOnce(bob.page, alice.page, bToA);

      console.log('[S1 direct stats]', JSON.stringify(await collectPcStats(alice.page)));
    } finally {
      await closeUsers(alice, bob);
    }
  });

  test('S2 TURN: relay-only establishes encrypted delivery over a selected relay pair', async ({ browser }) => {
    const alice = await setupUser(browser, 'turn-a', 'force-relay');
    const bob = await setupUser(browser, 'turn-b', 'force-relay');
    try {
      const roomId = await createRoom(alice.page, `Smoke TURN ${Date.now()}`);
      await joinRoom(bob.page, roomId);
      await expectEncrypted(alice.page, 120_000);
      await expectEncrypted(bob.page, 120_000);

      await sendAndExpectExactlyOnce(alice.page, bob.page, `S2 relay ${crypto.randomUUID()}`);

      const stats = await collectPcStats(alice.page);
      console.log('[S2 relay stats]', JSON.stringify(stats));
      expect(
        stats.some((row) => row.connectionState === 'connected' && row.local === 'relay'),
        'relay-only mode must select a local TURN relay candidate'
      ).toBe(true);
    } finally {
      await closeUsers(alice, bob);
    }
  });

  test('S3 honest fallback: WebRTC failure never claims encrypted', async ({ browser }) => {
    const alice = await setupUser(browser, 'fallback-a', 'disable');
    const bob = await setupUser(browser, 'fallback-b', 'disable');
    try {
      const roomId = await createRoom(alice.page, `Smoke fallback ${Date.now()}`);
      await joinRoom(bob.page, roomId);
      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });
      await alice.page.waitForTimeout(8_000);

      await expect(alice.page.getByTestId('e2ee-encrypted')).toHaveCount(0);
      await expect(
        alice.page.locator('[data-testid="e2ee-exchanging"], [data-testid="e2ee-plaintext"], .chat__status--failed').first()
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await closeUsers(alice, bob);
    }
  });
});
