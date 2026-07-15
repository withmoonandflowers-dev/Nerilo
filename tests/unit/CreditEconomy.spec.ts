/**
 * CreditEconomy 測試（點數經濟骨架，ADR-0020）
 *
 * - init 載入持久化餘額；新節點拿初始 grant
 * - 在線累積：每 tick pro-rata perUptimeHour
 * - trySpend：餘額足夠才扣，不足回 false 不扣
 * - subscribe：餘額變化通知
 * - 持久化 round-trip（localStorage stub）
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { CreditEconomy } from '../../src/core/incentive/CreditEconomy';
import { CreditLedger, webCryptoSigner, type EarnAttestation } from '../../src/core/incentive/CreditLedger';
import { createReceiptDraft, counterSign } from '../../src/core/incentive/CoSignedReceipt';

/** Spec 002：relay 賺點必附收據。測試共用一張真雙簽收據 fixture。 */
let receiptAtt: EarnAttestation;
beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const relay = webCryptoSigner(await gen());
  const requester = webCryptoSigner(await gen());
  const draft = await createReceiptDraft('relay-alice', 'req-bob', 10 * 1024, 1, 'fixture-nonce', relay.sign);
  const receipt = await counterSign(draft, requester.sign);
  receiptAtt = { kind: 'receipt', receipt, relayVerify: relay.verify, requesterVerify: requester.verify };
});

function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

describe('CreditEconomy', () => {
  let econ: CreditEconomy;

  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorageStub();
    econ = new CreditEconomy();
  });

  afterEach(() => {
    econ.reset();
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('新節點拿初始 grant（100）', async () => {
    econ.init('alice');
    const b = await econ.getBalance();
    expect(b?.balance).toBe(100);
  });

  it('未 init 時 facade 安全回傳空值', async () => {
    expect(await econ.getBalance()).toBeNull();
    expect(await econ.getServiceTier()).toBe('free');
    expect(await econ.trySpend(10, 'x')).toBe(false);
  });

  it('在線累積：每 tick 依 perUptimeHour pro-rata 加點', async () => {
    econ.init('alice');
    econ.startEarning();

    // 預設 perUptimeHour=10。前進 6 分鐘（6 tick）= 0.1 小時 = 1 點
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const b = await econ.getBalance();
    expect(b!.balance).toBeCloseTo(101, 5);

    econ.stopEarning();
  });

  it('stopEarning 後不再累積', async () => {
    econ.init('alice');
    econ.startEarning();
    await vi.advanceTimersByTimeAsync(60_000);
    econ.stopEarning();
    const before = (await econ.getBalance())!.balance;

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((await econ.getBalance())!.balance).toBe(before);
  });

  it('trySpend 餘額足夠才扣', async () => {
    econ.init('alice');
    expect(await econ.trySpend(30, 'game:powerup')).toBe(true);
    expect((await econ.getBalance())!.balance).toBe(70);
  });

  it('trySpend 不足（超過負債下限）回 false 且不扣', async () => {
    econ.init('alice');
    // 初始 100，下限 -100 → 最多花 200
    expect(await econ.trySpend(250, 'x')).toBe(false);
    expect((await econ.getBalance())!.balance).toBe(100);
  });

  it('subscribe 在賺/花時收到通知', async () => {
    econ.init('alice');
    const seen: number[] = [];
    econ.subscribe((b) => seen.push(b.balance));

    await econ.trySpend(10, 'x');
    econ.startEarning();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    econ.stopEarning();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(90); // 花掉 10
  });

  it('中繼貢獻產生點數：10KB → +15（10*perKb + perRelayBonus）', async () => {
    econ.init('alice');
    await econ.recordRelayContribution('bob', 10 * 1024, receiptAtt);
    // 初始 100 + (10*1 + 5) = 115
    expect((await econ.getBalance())!.balance).toBeCloseTo(115, 5);
  });

  it('中繼貢獻 0 bytes 不加點；未 init 安全 no-op', async () => {
    await econ.recordRelayContribution('bob', 1024, receiptAtt); // 未 init
    econ.init('alice');
    await econ.recordRelayContribution('bob', 0, receiptAtt);
    expect((await econ.getBalance())!.balance).toBe(100);
  });

  it('中繼貢獻通知 subscriber 且持久化', async () => {
    econ.init('alice');
    const seen: number[] = [];
    econ.subscribe((b) => seen.push(b.balance));
    await econ.recordRelayContribution('bob', 5 * 1024, receiptAtt); // +10

    expect(seen.length).toBeGreaterThanOrEqual(1);
    const econ2 = new CreditEconomy();
    econ2.init('alice');
    expect((await econ2.getBalance())!.balance).toBeCloseTo(110, 5);
  });

  it('持久化：重整（新實例）後餘額還原', async () => {
    econ.init('alice');
    await econ.trySpend(40, 'x'); // 100 → 60，觸發 persist

    const econ2 = new CreditEconomy();
    econ2.init('alice');
    expect((await econ2.getBalance())!.balance).toBe(60);
  });

  it('掛帳本：花點記進可驗證帳本，且帳本餘額對得上、verify ok', async () => {
    vi.useRealTimers(); // 本測試用真實 crypto（非 timer），避免 fake timer 卡住 async
    econ.init('alice');
    const ledger = new CreditLedger();
    econ.attachLedger(ledger);

    await econ.recordRelayContribution('bob', 10 * 1024, receiptAtt); // +15
    await econ.trySpend(40, 'game:powerup'); // -40
    await ledger.settled(); // 等佇列中的簽章串鏈 append 落定

    // 帳本記了 earn 15 + spend 40 = -25（帳本只記 attach 後的異動）
    expect(ledger.balance()).toBe(15 - 40);
    expect(await econ.verifyLedger()).toEqual({ ok: true });
    expect(econ.exportLedger()).toContain('relay');
  });

  it('未掛帳本 verifyLedger 回 ok、exportLedger 回 null', async () => {
    econ.init('alice');
    expect(await econ.verifyLedger()).toEqual({ ok: true });
    expect(econ.exportLedger()).toBeNull();
  });

  it('不同 nodeId 不會載到別人的餘額', async () => {
    econ.init('alice');
    await econ.trySpend(40, 'x'); // alice 存了 60

    const econ2 = new CreditEconomy();
    econ2.init('bob'); // 不同節點 → 拿自己的初始 grant
    expect((await econ2.getBalance())!.balance).toBe(100);
  });
});
