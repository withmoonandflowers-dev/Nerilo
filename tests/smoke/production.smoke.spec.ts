/**
 * Production 煙霧測試（取代大部分「真機兩台互測」的人工流程）。
 *
 * 三個場景：
 *  S1 直連黃金路徑：註冊/登入 → 建房 → 加入 → P2P 連線 → 雙向訊息 → E2EE 徽章
 *  S2 強制 TURN：iceTransportPolicy='relay' 讓連線必須經 TURN 伺服器——
 *     等效模擬「兩台裝置各在嚴格 NAT 後」的最壞情境。此測試失敗 = TURN
 *     未設定或憑證失效（行動網路使用者將退回備援模式）。
 *  S3 誠實降級：WebRTC 全滅時，UI 必須顯示金鑰交換中/失敗狀態，
 *     不得出現「端到端加密」的假徽章。
 *
 * 尚未涵蓋（仍需偶爾人工驗證）：iOS Safari、實體電信商 NAT 行為、
 * TURN 月流量額度耗盡的退化路徑。
 *
 * 測試帳號：.smoke-credentials.json（gitignored，首次執行自動產生並註冊）。
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  dismissWelcomeModal,
  createRoom,
  joinRoom,
  expectChatReady,
  sendMessage,
  expectMessageReceived,
  uniqueMessage,
} from '../e2e/_helpers/users';

// ── 測試帳號管理 ──────────────────────────────────────────────────────────

interface Cred {
  email: string;
  password: string;
}

const ARTIFACT_DIR = path.resolve(process.cwd(), 'smoke-artifacts');
const STATS_FILE = path.join(ARTIFACT_DIR, 'stats.jsonl');

/**
 * 每次呼叫產生全新帳號（不持久化、不共用）。煙霧測試每個場景各自註冊，
 * 消除「共用帳號被上一個場景註冊後、後續場景 login/register 相撞」的脆弱。
 */
function freshCred(tag: string): Cred {
  return {
    email: `smoke-${tag}-${crypto.randomBytes(5).toString('hex')}@nerilo-smoke.test`,
    password: `Sm0ke-${crypto.randomBytes(9).toString('base64url')}`,
  };
}

function appendStats(record: Record<string, unknown>): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.appendFileSync(STATS_FILE, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
}

// ── WebRTC 攔截（收集統計 / 強制 relay / 停用） ──────────────────────────

type RtcMode = 'observe' | 'force-relay' | 'disable';

function rtcInitScript(mode: RtcMode): string {
  return `
    (() => {
      window.__pcs = [];
      const Orig = window.RTCPeerConnection;
      if (${JSON.stringify(mode)} === 'disable') {
        window.RTCPeerConnection = function () {
          throw new Error('WebRTC disabled by smoke test');
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

interface PcStats {
  connectionState: string;
  local: string | null;
  remote: string | null;
  rttMs: number | null;
}

async function collectPcStats(page: Page): Promise<PcStats[]> {
  return page.evaluate(async () => {
    const out: PcStats[] = [];
    type AnyRec = Record<string, unknown>;
    const pcs = ((window as unknown as AnyRec).__pcs as RTCPeerConnection[]) || [];
    for (const pc of pcs) {
      try {
        const stats = await pc.getStats();
        const byId = new Map<string, AnyRec>();
        stats.forEach((r) => byId.set((r as AnyRec).id as string, r as AnyRec));
        let pair: AnyRec | null = null;
        stats.forEach((r) => {
          const rec = r as AnyRec;
          if (rec.type === 'candidate-pair' && rec.state === 'succeeded' && (rec.nominated || rec.selected)) {
            pair = rec;
          }
        });
        if (!pair) {
          stats.forEach((r) => {
            const rec = r as AnyRec;
            if (rec.type === 'transport' && rec.selectedCandidatePairId) {
              pair = byId.get(rec.selectedCandidatePairId as string) ?? null;
            }
          });
        }
        if (pair) {
          const p = pair as AnyRec;
          const local = byId.get(p.localCandidateId as string);
          const remote = byId.get(p.remoteCandidateId as string);
          out.push({
            connectionState: pc.connectionState,
            local: (local?.candidateType as string) ?? null,
            remote: (remote?.candidateType as string) ?? null,
            rttMs:
              typeof p.currentRoundTripTime === 'number'
                ? Math.round((p.currentRoundTripTime as number) * 1000)
                : null,
          });
        } else {
          out.push({ connectionState: pc.connectionState, local: null, remote: null, rttMs: null });
        }
      } catch {
        out.push({ connectionState: 'stats-error', local: null, remote: null, rttMs: null });
      }
    }
    return out;
  });
}

// ── 登入/註冊 ─────────────────────────────────────────────────────────────

async function registerFresh(page: Page, cred: Cred): Promise<void> {
  await page.goto('/login');
  await page.locator('.auth-toggle-link').click();
  await expect(page.locator('.login-form button[type="submit"]')).toHaveText('註冊');
  await page.fill('#email', cred.email);
  await page.fill('#password', cred.password);
  await page.locator('.login-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  // 等 AuthContext 把註冊完成的（非匿名）帳號結算成 role='user' 再往下。
  // 正式站 guestCreateAllowed=false：若在 user 尚未結算（null/guest）時就按「建立房間」，
  // goCreateRoom 會把人導回 /login → 後續 createRoom 卡在等不到「建立房間」確認鈕。
  // 與 e2e helper 的 setupUser 同一道等待（role-badge 讀到 user）。
  await expect(page.locator('.role-badge')).toContainText('user', { timeout: 10_000 });
  await dismissWelcomeModal(page);
}

interface SmokeUser {
  ctx: BrowserContext;
  page: Page;
}

/**
 * 配額耗盡偵測（診斷 2026-07-13）：Firestore 免費額度打爆時，joinRoom 等寫入吃
 * resource-exhausted/429，症狀是各種「不透明的等待逾時」（如 alice 卡 /waiting）。
 * 收集事件讓 afterEach 把失敗翻譯成明確診斷，而不是留一個 120s timeout 謎題。
 */
const quotaEvents: string[] = [];

test.afterEach(({}, testInfo) => {
  if (testInfo.status !== 'passed' && quotaEvents.length > 0) {
    const msg =
      `Firestore 配額耗盡（resource-exhausted/429，共 ${quotaEvents.length} 筆）——` +
      `本次失敗極可能是額度問題而非功能迴歸。請查 Firebase console 用量，額度重置後重跑。` +
      `首筆：${quotaEvents[0]}`;
    testInfo.annotations.push({ type: 'quota-exhausted', description: msg });
    console.error(`\n!!! ${msg}\n`);
  }
  quotaEvents.length = 0;
});

async function setupSmokeUser(browser: Browser, tag: string, mode: RtcMode): Promise<SmokeUser> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(rtcInitScript(mode));
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (/resource-exhausted|Quota exceeded|status of 429/i.test(t)) {
      quotaEvents.push(`[${tag}] ${t.slice(0, 160)}`);
    }
  });
  await registerFresh(page, freshCred(tag));
  return { ctx, page };
}

/**
 * 等 E2EE 進入「已加密」穩態。ADR-0004 之後，星型房「連線就緒」不等於
 * 「可發送」——金鑰交換完成才是發送閘門。發訊前必須先過這關，
 * 否則會在 exchanging 狀態送出而被 waitForE2EEReady 阻擋。
 */
async function expectE2EESettled(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect(page.locator('.e2ee-indicator-p2p, .e2ee-indicator-fallback')).toBeVisible({
    timeout: timeoutMs,
  });
  await expect(page.locator('.e2ee-indicator-exchanging')).toHaveCount(0);
}

async function closeUsers(...users: SmokeUser[]): Promise<void> {
  for (const u of users) {
    try {
      await u.ctx.close();
    } catch {
      /* ignore */
    }
  }
}

// ── 場景 ─────────────────────────────────────────────────────────────────


test.describe('production smoke', () => {
  test('S1 直連黃金路徑：建房 → 加入 → P2P → 雙向訊息 → E2EE 徽章', async ({ browser }) => {
    const alice = await setupSmokeUser(browser, 'a', 'observe');
    const bob = await setupSmokeUser(browser, 'b', 'observe');
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);
      await expectChatReady(alice.page, 60_000);
      await expectChatReady(bob.page, 60_000);
      // 金鑰交換完成才是發送閘門（ADR-0004）
      await expectE2EESettled(alice.page);
      await expectE2EESettled(bob.page);

      const t0 = Date.now();
      const msgAtoB = uniqueMessage('S1 A→B');
      await sendMessage(alice.page, msgAtoB);
      await expectMessageReceived(bob.page, msgAtoB, 15_000);
      const latencyAtoB = Date.now() - t0;

      const t1 = Date.now();
      const msgBtoA = uniqueMessage('S1 B→A');
      await sendMessage(bob.page, msgBtoA);
      await expectMessageReceived(alice.page, msgBtoA, 15_000);
      const latencyBtoA = Date.now() - t1;

      // E2EE 徽章必須是「已加密」變體，不是交換中
      await expect(alice.page.locator('.e2ee-indicator-p2p, .e2ee-indicator-fallback')).toBeVisible({
        timeout: 15_000,
      });

      const aliceStats = await collectPcStats(alice.page);
      appendStats({
        scenario: 'S1-direct',
        roomId,
        latencyMsAtoB: latencyAtoB,
        latencyMsBtoA: latencyBtoA,
        pcStats: aliceStats,
      });
    } finally {
      await closeUsers(alice, bob);
    }
  });

  test('S2 強制 TURN（等效雙嚴格 NAT）：relay-only 必須連得上', async ({ browser }) => {
    const alice = await setupSmokeUser(browser, 'a', 'force-relay');
    const bob = await setupSmokeUser(browser, 'b', 'force-relay');
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);

      // relay-only 下必須達到 P2P 已連線（經 TURN）。若退到備援模式，
      // 代表 TURN 未設定或憑證失效——此測試「應該」失敗以發出警報。
      await expect(alice.page.locator('.connection-banner-text')).toHaveText(/已連線/, {
        timeout: 90_000,
      });
      await expect(bob.page.locator('.connection-banner-text')).toHaveText(/已連線/, {
        timeout: 30_000,
      });
      await expectE2EESettled(alice.page);
      await expectE2EESettled(bob.page);

      const t0 = Date.now();
      const msg = uniqueMessage('S2 via-TURN');
      await sendMessage(alice.page, msg);
      await expectMessageReceived(bob.page, msg, 15_000);
      const latency = Date.now() - t0;

      const aliceStats = await collectPcStats(alice.page);
      // 硬證據：選中的 candidate pair 本端必須是 relay
      const relayPairs = aliceStats.filter((s) => s.local === 'relay');
      expect(relayPairs.length, 'relay-only 模式下選中的 candidate 必須是 relay 型').toBeGreaterThan(0);

      appendStats({ scenario: 'S2-forced-turn', roomId, latencyMs: latency, pcStats: aliceStats });
    } finally {
      await closeUsers(alice, bob);
    }
  });

  test('S3 誠實降級：WebRTC 全滅 → 不得出現假的 E2EE 已加密徽章', async ({ browser }) => {
    const alice = await setupSmokeUser(browser, 'a', 'disable');
    const bob = await setupSmokeUser(browser, 'b', 'disable');
    try {
      const roomId = await createRoom(alice.page);
      await joinRoom(bob.page, roomId);

      await expect(alice.page).toHaveURL(/\/chat\/.+/, { timeout: 20_000 });

      // 金鑰交換無法完成：「端到端加密」的已加密徽章絕不能出現
      await alice.page.waitForTimeout(8_000); // 給 UI 足夠時間進入穩態
      await expect(alice.page.locator('.e2ee-indicator-p2p')).toHaveCount(0);

      // 可接受的誠實狀態：金鑰交換中徽章，或連線失敗/備援的 banner
      const honest = alice.page.locator(
        '.e2ee-indicator-exchanging, .connection-banner-text'
      );
      await expect(honest.first()).toBeVisible({ timeout: 10_000 });

      appendStats({ scenario: 'S3-degradation', roomId, honest: true });
    } finally {
      await closeUsers(alice, bob);
    }
  });
});
