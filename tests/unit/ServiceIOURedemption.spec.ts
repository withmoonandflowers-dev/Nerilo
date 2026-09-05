/**
 * Protocol Spec 031 D2：兌換、餘額、防重放與 custody-byte-days 履約。
 * @vitest-environment node
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import {
  CourierIOUBook,
  createDepositIOU,
  type CourierIOUBookConfig,
  type CourierIOUPersistence,
  type CourierIOUSnapshot,
} from '../../src/core/incentive/CourierIOU';
import {
  createEndorsement,
  createServiceIOU,
  iouHash,
  type ServiceDenomination,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOUParty,
  type UnsignedServiceIOU,
} from '../../src/core/incentive/ServiceIOU';
import {
  createRedeemRequest,
  IssuerRedemptionBook,
  type IssuerRedemptionPersistence,
  type IssuerRedemptionSnapshot,
  type ServiceRedeemRequest,
} from '../../src/core/incentive/ServiceIOURedemption';
import type { SignFn } from '../../src/core/incentive/CoSignedReceipt';

const NOW = 1_788_700_000_000;
const EXPIRES_AT = NOW + 3_600_000;
const DAY_MS = 86_400_000;

interface Party extends ServiceIOUParty {
  sign: SignFn;
}

let issuer: Party;
let firstHolder: Party;
let secondHolder: Party;
let attacker: Party;

async function party(): Promise<Party> {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', keys.publicKey));
  return {
    nodeId: await senderIdFromPubKey(pubKey),
    pubKey,
    sign: ecdsaSigner(keys.privateKey),
  };
}

beforeAll(async () => {
  [issuer, firstHolder, secondHolder, attacker] = await Promise.all([
    party(), party(), party(), party(),
  ]);
});

async function makeIOU(
  denomination: ServiceDenomination = { unit: 'relay-bytes', amount: 100 },
  overrides: Partial<UnsignedServiceIOU> = {}
): Promise<ServiceIOU> {
  return createServiceIOU({
    v: 'nsiou1',
    iouId: crypto.randomUUID(),
    kind: 'registered',
    issuer: { nodeId: issuer.nodeId, pubKey: issuer.pubKey },
    holder: { nodeId: firstHolder.nodeId, pubKey: firstHolder.pubKey },
    denomination,
    issuedAt: NOW,
    expiresAt: EXPIRES_AT,
    nonce: crypto.randomUUID(),
    ...overrides,
  }, issuer.sign);
}

async function makeEndorsable(): Promise<{ iou: ServiceIOU; chain: ServiceEndorsement[] }> {
  const iou = await makeIOU({ unit: 'relay-bytes', amount: 100 }, { kind: 'endorsable' });
  const transfer = await createEndorsement({
    v: 'nsend1',
    iouId: iou.iouId,
    seq: 1,
    from: { nodeId: firstHolder.nodeId, pubKey: firstHolder.pubKey },
    toNodeId: secondHolder.nodeId,
    prevHash: await iouHash(iou),
    swapPairHash: null,
    endorsedAt: NOW + 1_000,
    nonce: crypto.randomUUID(),
  }, firstHolder.sign);
  return { iou, chain: [transfer] };
}

async function request(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  claimant: Party,
  requested: ServiceDenomination = { ...iou.denomination, amount: 10 }
): Promise<ServiceRedeemRequest> {
  return createRedeemRequest(iou, chain, claimant, requested, NOW + 2_000, claimant.sign);
}

function redemptionPersistence(initial: IssuerRedemptionSnapshot | null = null) {
  let snapshot = initial ? structuredClone(initial) : null;
  const persistence: IssuerRedemptionPersistence = {
    async load() { return snapshot ? structuredClone(snapshot) : null; },
    async save(next) { snapshot = structuredClone(next); },
  };
  return { persistence, snapshot: () => snapshot ? structuredClone(snapshot) : null };
}

function courierPersistence(initial: CourierIOUSnapshot | null = null) {
  let snapshot = initial ? structuredClone(initial) : null;
  const persistence: CourierIOUPersistence = {
    async load() { return snapshot ? structuredClone(snapshot) : null; },
    async save(next) { snapshot = structuredClone(next); },
  };
  return { persistence, snapshot: () => snapshot ? structuredClone(snapshot) : null };
}

function courierConfig(overrides: Partial<CourierIOUBookConfig> = {}): CourierIOUBookConfig {
  return {
    creditLimitPerIssuer: 0,
    quoteTtlMs: 30_000,
    pricingIntervalMs: 60_000,
    storageDurationMs: 14 * DAY_MS,
    initialStoragePrice: 0.001,
    contributionPricePerByte: 0.000_001,
    pricing: {
      targetUtilization: 0.5,
      adjustmentRate: 0.1,
      minPrice: 0.000_001,
      maxPrice: 1,
    },
    ...overrides,
  };
}

describe('ServiceIOU D2 兌換正向路徑', () => {
  it.each<ServiceDenomination>([
    { unit: 'relay-bytes', amount: 100 },
    { unit: 'custody-byte-days', amount: 100 },
    { unit: 'priority', amount: 3 },
  ])('記名憑證的第一手持有人可兌換 $unit', async (denomination) => {
    const iou = await makeIOU(denomination);
    const redeem = await request(iou, [], firstHolder, { ...denomination, amount: 1 });
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, [], redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: true, granted: 1, remaining: denomination.amount - 1 });
  });

  it('可背書憑證由鏈末持有人兌換成功', async () => {
    const { iou, chain } = await makeEndorsable();
    const redeem = await request(iou, chain, secondHolder);
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, chain, redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: true, granted: 10, remaining: 90 });
  });

  it('部分兌換兩次後餘額歸零', async () => {
    const iou = await makeIOU({ unit: 'priority', amount: 2 });
    const book = new IssuerRedemptionBook(issuer.nodeId);
    const first = await request(iou, [], firstHolder, { unit: 'priority', amount: 1 });
    const second = await request(iou, [], firstHolder, { unit: 'priority', amount: 1 });
    expect(await book.redeem(iou, [], first, { now: NOW + 3_000 }))
      .toEqual({ accepted: true, granted: 1, remaining: 1 });
    expect(await book.redeem(iou, [], second, { now: NOW + 3_000 }))
      .toEqual({ accepted: true, granted: 1, remaining: 0 });
    const third = await request(iou, [], firstHolder, { unit: 'priority', amount: 1 });
    expect(await book.redeem(iou, [], third, { now: NOW + 3_000 }))
      .toEqual({ accepted: false, reason: 'insufficient-balance' });
  });

  it('兌換餘額與 nonce 防重放狀態可持久化', async () => {
    const durable = redemptionPersistence();
    const iou = await makeIOU();
    const redeem = await request(iou, [], firstHolder);
    const first = new IssuerRedemptionBook(issuer.nodeId, durable.persistence);
    expect(await first.redeem(iou, [], redeem, { now: NOW + 3_000 })).toMatchObject({ accepted: true });
    expect(await first.flush()).toBe(true);

    const restored = new IssuerRedemptionBook(issuer.nodeId, durable.persistence);
    await restored.hydrate();
    expect(restored.remaining(iou.iouId)).toBe(90);
    expect(await restored.redeem(iou, [], redeem, { now: NOW + 3_000 }))
      .toEqual({ accepted: false, reason: 'malformed' });
  });

  it('custody-byte-days 兌換後，同一筆原遭拒的寄存欠條會被接受', async () => {
    const cfg = courierConfig();
    const courierBook = new CourierIOUBook(issuer.nodeId, issuer.sign, cfg, () => NOW);
    const quote = courierBook.issueQuote(firstHolder.nodeId, 100, 0);
    const deposit = await createDepositIOU(quote, NOW, firstHolder.sign);
    expect(await courierBook.acceptDepositIOU(deposit, firstHolder.pubKey))
      .toEqual({ accepted: false, reason: 'insufficient-credit' });

    const byteDays = quote.bytes * (quote.durationMs / DAY_MS);
    const iou = await makeIOU({ unit: 'custody-byte-days', amount: byteDays });
    const redeem = await request(iou, [], firstHolder, iou.denomination);
    const redemptionBook = new IssuerRedemptionBook(issuer.nodeId, undefined, courierBook);
    expect(await redemptionBook.redeem(iou, [], redeem, { now: NOW + 3_000 }))
      .toEqual({ accepted: true, granted: byteDays, remaining: 0 });
    expect(courierBook.grantedCustodyCredit(firstHolder.nodeId)).toBe(quote.amount);
    expect(await courierBook.acceptDepositIOU(deposit, firstHolder.pubKey))
      .toEqual({ accepted: true, amount: quote.amount });
  });

  it('custody 配額與兌換當下價格換算後可跨重載保留', async () => {
    const durable = courierPersistence();
    const cfg = courierConfig({ creditLimitPerIssuer: 1 });
    const first = new CourierIOUBook(
      issuer.nodeId, issuer.sign, cfg, () => NOW, durable.persistence, issuer.pubKey
    );
    first.issueQuote(firstHolder.nodeId, 1, 1);
    const granted = first.grantCustodyQuota(firstHolder.nodeId, 1_000);
    expect(granted).toBeGreaterThan(cfg.initialStoragePrice * 1_000);
    expect(await first.flush()).toBe(true);
    expect(durable.snapshot()?.version).toBe(2);

    const restored = new CourierIOUBook(
      issuer.nodeId, issuer.sign, cfg, () => NOW, durable.persistence, issuer.pubKey
    );
    await restored.hydrate();
    expect(restored.grantedCustodyCredit(firstHolder.nodeId)).toBe(granted);
    expect(restored.availableCredit(firstHolder.nodeId)).toBe(1 + granted);
  });

  it('版本 1 快照沒有授予配額時可載入且配額視為零', async () => {
    const cfg = courierConfig({ creditLimitPerIssuer: 1 });
    const oldSnapshot: CourierIOUSnapshot = {
      version: 1,
      ownerNodeId: issuer.nodeId,
      claims: [],
      acceptedContributions: [],
      currentStoragePrice: cfg.initialStoragePrice,
      lastPriceUpdateAt: null,
    };
    const durable = courierPersistence(oldSnapshot);
    const restored = new CourierIOUBook(
      issuer.nodeId, issuer.sign, cfg, () => NOW, durable.persistence, issuer.pubKey
    );
    await restored.hydrate();
    expect(restored.grantedCustodyCredit(firstHolder.nodeId)).toBe(0);
    expect(restored.availableCredit(firstHolder.nodeId)).toBe(1);
  });
});

describe('ServiceIOU D2 兌換負向路徑', () => {
  it('記名憑證帶背書鏈回 malformed', async () => {
    const { iou: endorsable, chain } = await makeEndorsable();
    const iou = await makeIOU(undefined, { iouId: endorsable.iouId });
    const redeem = await request(iou, chain, secondHolder);
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, chain, redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'malformed' });
  });

  it('可背書憑證的舊持有人兌換回 chain-broken', async () => {
    const { iou, chain } = await makeEndorsable();
    const redeem = await request(iou, chain, firstHolder);
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, chain, redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'chain-broken' });
  });

  it('兌換單位與憑證不符回 malformed', async () => {
    const iou = await makeIOU();
    const redeem = await request(iou, [], firstHolder, { unit: 'priority', amount: 1 });
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, [], redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'malformed' });
  });

  it.each([0, -1, 1.5])('requested.amount=%s 回 malformed', async (amount) => {
    const iou = await makeIOU();
    const redeem = await request(iou, [], firstHolder);
    const malformed = {
      ...redeem,
      requested: { ...redeem.requested, amount },
    };
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, [], malformed, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'malformed' });
  });

  it('requested.amount 超過餘額回 insufficient-balance', async () => {
    const iou = await makeIOU({ unit: 'relay-bytes', amount: 5 });
    const redeem = await request(iou, [], firstHolder, { unit: 'relay-bytes', amount: 6 });
    const book = new IssuerRedemptionBook(issuer.nodeId);
    await expect(book.redeem(
      iou, [], redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'insufficient-balance' });
    expect(book.remaining(iou.iouId)).toBeNull();
  });

  it('同一兌換 nonce 重放回 malformed', async () => {
    const iou = await makeIOU();
    const redeem = await request(iou, [], firstHolder);
    const book = new IssuerRedemptionBook(issuer.nodeId);
    expect(await book.redeem(iou, [], redeem, { now: NOW + 3_000 })).toMatchObject({ accepted: true });
    expect(await book.redeem(iou, [], redeem, { now: NOW + 3_000 }))
      .toEqual({ accepted: false, reason: 'malformed' });
  });

  it('本開票人未見過的外部憑證回 unknown-iou', async () => {
    const externalUnsigned: UnsignedServiceIOU = {
      v: 'nsiou1',
      iouId: crypto.randomUUID(),
      kind: 'registered',
      issuer: { nodeId: attacker.nodeId, pubKey: attacker.pubKey },
      holder: { nodeId: firstHolder.nodeId, pubKey: firstHolder.pubKey },
      denomination: { unit: 'relay-bytes', amount: 100 },
      issuedAt: NOW,
      expiresAt: EXPIRES_AT,
      nonce: crypto.randomUUID(),
    };
    const externalIOU = await createServiceIOU(externalUnsigned, attacker.sign);
    const redeem = await createRedeemRequest(
      externalIOU, [], firstHolder, { unit: 'relay-bytes', amount: 1 },
      NOW + 2_000, firstHolder.sign
    );
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      externalIOU, [], redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'unknown-iou' });
  });

  it('claimant 公鑰與 nodeId 不綁定回 identity-mismatch', async () => {
    const iou = await makeIOU();
    const redeem = await createRedeemRequest(
      iou,
      [],
      { nodeId: firstHolder.nodeId, pubKey: attacker.pubKey },
      { unit: 'relay-bytes', amount: 1 },
      NOW + 2_000,
      attacker.sign
    );
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, [], redeem, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'identity-mismatch' });
  });

  it('兌換簽章造假回 bad-signature', async () => {
    const iou = await makeIOU();
    const redeem = await request(iou, [], firstHolder);
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, [], { ...redeem, signature: `${redeem.signature}A` }, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'bad-signature' });
  });

  it('請求內嵌的憑證與外部驗證憑證不一致回 chain-broken', async () => {
    const iou = await makeIOU();
    const redeem = await request(iou, [], firstHolder);
    const other = await makeIOU();
    await expect(new IssuerRedemptionBook(issuer.nodeId).redeem(
      iou, [], { ...redeem, iou: other }, { now: NOW + 3_000 }
    )).resolves.toEqual({ accepted: false, reason: 'chain-broken' });
  });
});
