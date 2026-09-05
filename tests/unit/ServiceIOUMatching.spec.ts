/**
 * Protocol Spec 031 D3：交換意向、配對與條件背書成對驗證。
 * @vitest-environment node
 */
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import type { SignFn } from '../../src/core/incentive/CoSignedReceipt';
import {
  createEndorsement,
  createServiceIOU,
  iouHash,
  type ServiceDenomination,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOUParty,
} from '../../src/core/incentive/ServiceIOU';
import {
  createSwapIntent,
  createSwapPair,
  SwapMatcher,
  swapIntentHash,
  swapPairHash,
  verifySwapBundle,
  verifySwapIntent,
  verifySwapPair,
  type SwapEndorsementLeg,
  type SwapIntent,
  type SwapPair,
  type UnsignedSwapIntent,
} from '../../src/core/incentive/ServiceIOUMatching';

const NOW = 1_788_700_000_000;
const EXPIRES_AT = NOW + 60_000;

interface Party extends ServiceIOUParty {
  sign: SignFn;
}

interface Scenario {
  iouA: ServiceIOU;
  iouB: ServiceIOU;
  intentA: SwapIntent;
  intentB: SwapIntent;
  pair: SwapPair;
  legA: SwapEndorsementLeg;
  legB: SwapEndorsementLeg;
}

let issuerA: Party;
let issuerB: Party;
let holderA: Party;
let holderB: Party;
let matcher: Party;

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
  [issuerA, issuerB, holderA, holderB, matcher] = await Promise.all([
    party(), party(), party(), party(), party(),
  ]);
});

async function makeIOU(
  issuer: Party,
  holder: Party,
  denomination: ServiceDenomination
): Promise<ServiceIOU> {
  return createServiceIOU({
    v: 'nsiou1',
    iouId: crypto.randomUUID(),
    kind: 'endorsable',
    issuer: { nodeId: issuer.nodeId, pubKey: issuer.pubKey },
    holder: { nodeId: holder.nodeId, pubKey: holder.pubKey },
    denomination,
    issuedAt: NOW,
    expiresAt: NOW + 120_000,
    nonce: crypto.randomUUID(),
  }, issuer.sign);
}

async function makeIntent(
  iou: ServiceIOU,
  holder: Party,
  want: UnsignedSwapIntent['want'],
  wantIssuers: string[] | null = null,
  expiresAt = EXPIRES_AT
): Promise<SwapIntent> {
  return createSwapIntent({
    v: 'nswapintent1',
    intentId: crypto.randomUUID(),
    offer: {
      iouId: iou.iouId,
      issuerNodeId: iou.issuer.nodeId,
      denomination: { ...iou.denomination },
    },
    want,
    wantIssuers,
    holder: { nodeId: holder.nodeId, pubKey: holder.pubKey },
    expiresAt,
    nonce: crypto.randomUUID(),
  }, holder.sign);
}

async function scenario(): Promise<Scenario> {
  const iouA = await makeIOU(issuerA, holderA, { unit: 'relay-bytes', amount: 10 });
  const iouB = await makeIOU(issuerB, holderB, { unit: 'custody-byte-days', amount: 20 });
  const intentA = await makeIntent(iouA, holderA, { unit: 'custody-byte-days', minAmount: 20 });
  const intentB = await makeIntent(iouB, holderB, { unit: 'relay-bytes', minAmount: 10 });
  const pair = await createSwapPair({
    v: 'nswappair1',
    pairId: crypto.randomUUID(),
    intentHashes: await Promise.all([swapIntentHash(intentB), swapIntentHash(intentA)]),
    matcher: { nodeId: matcher.nodeId, pubKey: matcher.pubKey },
    proposedAt: NOW + 1_000,
    expiresAt: EXPIRES_AT,
    nonce: crypto.randomUUID(),
  }, matcher.sign);
  const pairHash = await swapPairHash(pair);
  const endorsementA = await createEndorsement({
    v: 'nsend1',
    iouId: iouA.iouId,
    seq: 1,
    from: { nodeId: holderA.nodeId, pubKey: holderA.pubKey },
    toNodeId: holderB.nodeId,
    prevHash: await iouHash(iouA),
    swapPairHash: pairHash,
    endorsedAt: NOW + 2_000,
    nonce: crypto.randomUUID(),
  }, holderA.sign);
  const endorsementB = await createEndorsement({
    v: 'nsend1',
    iouId: iouB.iouId,
    seq: 1,
    from: { nodeId: holderB.nodeId, pubKey: holderB.pubKey },
    toNodeId: holderA.nodeId,
    prevHash: await iouHash(iouB),
    swapPairHash: pairHash,
    endorsedAt: NOW + 2_000,
    nonce: crypto.randomUUID(),
  }, holderB.sign);
  return {
    iouA,
    iouB,
    intentA,
    intentB,
    pair,
    legA: { iou: iouA, chain: [endorsementA] },
    legB: { iou: iouB, chain: [endorsementB] },
  };
}

const bundleOptions = () => ({ now: NOW + 3_000 });

describe('ServiceIOU D3 正向撮合', () => {
  it('交換意向可簽、可驗並產生小寫 SHA-256 hash', async () => {
    const { intentA } = await scenario();
    await expect(verifySwapIntent(intentA, { now: NOW + 3_000 })).resolves.toEqual({ ok: true });
    await expect(swapIntentHash(intentA)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('建立配對時將 intentHashes 依字典序排列並可驗章', async () => {
    const { pair } = await scenario();
    expect(pair.intentHashes).toEqual([...pair.intentHashes].sort());
    await expect(verifySwapPair(pair, { now: NOW + 3_000 }))
      .resolves.toEqual({ ok: true });
  });

  it('SwapMatcher 只接觸意向與配對，找到雙向相容報價', async () => {
    expectTypeOf<Parameters<SwapMatcher['addIntent']>[0]>().toEqualTypeOf<SwapIntent>();
    expectTypeOf<Parameters<SwapMatcher['addIntent']>[0]>().not.toEqualTypeOf<ServiceIOU>();
    const { intentA, intentB } = await scenario();
    const swapMatcher = new SwapMatcher(() => NOW + 3_000);
    expect(await swapMatcher.addIntent(intentA)).toBe(true);
    expect(await swapMatcher.addIntent(intentB)).toBe(true);
    const proposed = await swapMatcher.proposeMatch(matcher, matcher.sign, EXPIRES_AT);
    expect(proposed).not.toBeNull();
    expect(proposed?.intents).toEqual([intentA, intentB]);
    expect(Object.keys(proposed!.pair).sort()).toEqual([
      'expiresAt', 'intentHashes', 'matcher', 'nonce', 'pairId',
      'proposedAt', 'signature', 'v',
    ]);
    expect(swapMatcher.pendingIntents()).toEqual([]);
  });

  it('兩造條件背書成對且綁同一配對時通過', async () => {
    const { pair, intentA, intentB, legA, legB } = await scenario();
    await expect(verifySwapBundle(
      pair, [intentA, intentB], [legA, legB], bundleOptions()
    )).resolves.toEqual({ ok: true });
  });

  it('同一 bundle 重複純驗證，結果相同且輸入不變', async () => {
    const { pair, intentA, intentB, legA, legB } = await scenario();
    const input = { pair, intents: [intentA, intentB], endorsements: [legA, legB] };
    const before = structuredClone(input);
    const first = await verifySwapBundle(pair, input.intents, input.endorsements, bundleOptions());
    const second = await verifySwapBundle(pair, input.intents, input.endorsements, bundleOptions());
    expect(first).toEqual({ ok: true });
    expect(second).toEqual(first);
    expect(input).toEqual(before);
    // 本層不假裝保存防重放狀態；不得產生第二次轉移由 D4 開票人登記簿負責。
  });
});

describe('ServiceIOU D3 負向與不配對路徑', () => {
  it('簽過的意向內容遭改動回 bad-signature', async () => {
    const { intentA } = await scenario();
    await expect(verifySwapIntent({
      ...intentA,
      want: { ...intentA.want, minAmount: intentA.want.minAmount + 1 },
    }, { now: NOW + 3_000 })).resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('未依字典序排列的配對回 malformed', async () => {
    const { pair } = await scenario();
    const descending = [...pair.intentHashes].sort().reverse() as [string, string];
    await expect(verifySwapPair({ ...pair, intentHashes: descending }, {
      now: NOW + 3_000,
    })).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('matcher.pubKey 與 nodeId 不綁定回 identity-mismatch', async () => {
    const { pair } = await scenario();
    await expect(verifySwapPair({
      ...pair,
      matcher: { ...pair.matcher, pubKey: holderA.pubKey },
    }, { now: NOW + 3_000 })).resolves.toEqual({
      ok: false,
      reason: 'identity-mismatch',
    });
  });

  it('一方不履約，只給一則條件背書回 swap-incomplete', async () => {
    const { pair, intentA, intentB, legA } = await scenario();
    await expect(verifySwapBundle(pair, [intentA, intentB], [legA], bundleOptions()))
      .resolves.toEqual({ ok: false, reason: 'swap-incomplete' });
  });

  it('同時逾時且缺一則時，優先回 swap-expired', async () => {
    const { pair, intentA, intentB, legA } = await scenario();
    await expect(verifySwapBundle(pair, [intentA, intentB], [legA], {
      now: pair.expiresAt + 1,
    })).resolves.toEqual({ ok: false, reason: 'swap-expired' });
  });

  it('pair.intentHashes 被換掉但未重簽回 bad-signature', async () => {
    const { pair, intentA, intentB, legA, legB } = await scenario();
    const changed = [pair.intentHashes[0], 'f'.repeat(64)].sort() as [string, string];
    await expect(verifySwapBundle(
      { ...pair, intentHashes: changed },
      [intentA, intentB],
      [legA, legB],
      bundleOptions()
    )).resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('錯誤 intentHashes 經撮合者重簽後，仍因不符實際意向回 malformed', async () => {
    const { pair, intentA, intentB, legA, legB } = await scenario();
    const resigned = await createSwapPair({
      v: 'nswappair1',
      pairId: pair.pairId,
      intentHashes: ['0'.repeat(64), 'f'.repeat(64)],
      matcher: { nodeId: matcher.nodeId, pubKey: matcher.pubKey },
      proposedAt: pair.proposedAt,
      expiresAt: pair.expiresAt,
      nonce: pair.nonce,
    }, matcher.sign);
    await expect(verifySwapBundle(
      resigned, [intentA, intentB], [legA, legB], bundleOptions()
    )).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('過期意向被剔除，不會提出配對', async () => {
    const { iouA, intentB } = await scenario();
    const expired = await makeIntent(
      iouA,
      holderA,
      { unit: 'custody-byte-days', minAmount: 20 },
      null,
      NOW + 2_000
    );
    const swapMatcher = new SwapMatcher(() => NOW + 3_000);
    expect(await swapMatcher.addIntent(expired)).toBe(false);
    expect(await swapMatcher.addIntent(intentB)).toBe(true);
    expect(await swapMatcher.proposeMatch(matcher, matcher.sign, EXPIRES_AT)).toBeNull();
  });

  it('對方 offer 未達 want.minAmount 時不配對', async () => {
    const { iouA, iouB } = await scenario();
    const intentA = await makeIntent(iouA, holderA, { unit: 'custody-byte-days', minAmount: 21 });
    const intentB = await makeIntent(iouB, holderB, { unit: 'relay-bytes', minAmount: 10 });
    const swapMatcher = new SwapMatcher(() => NOW + 3_000);
    await swapMatcher.addIntent(intentA);
    await swapMatcher.addIntent(intentB);
    expect(await swapMatcher.proposeMatch(matcher, matcher.sign, EXPIRES_AT)).toBeNull();
  });

  it('對方 issuer 不在 wantIssuers 名單時不配對', async () => {
    const { iouA, iouB } = await scenario();
    const intentA = await makeIntent(
      iouA,
      holderA,
      { unit: 'custody-byte-days', minAmount: 20 },
      ['not-issuer-b']
    );
    const intentB = await makeIntent(iouB, holderB, { unit: 'relay-bytes', minAmount: 10 });
    const swapMatcher = new SwapMatcher(() => NOW + 3_000);
    await swapMatcher.addIntent(intentA);
    await swapMatcher.addIntent(intentB);
    expect(await swapMatcher.proposeMatch(matcher, matcher.sign, EXPIRES_AT)).toBeNull();
  });

  it('條件背書指向自己而非對方時回 chain-broken', async () => {
    const { iouA, pair, intentA, intentB, legB } = await scenario();
    const wrong: ServiceEndorsement = await createEndorsement({
      v: 'nsend1',
      iouId: iouA.iouId,
      seq: 1,
      from: { nodeId: holderA.nodeId, pubKey: holderA.pubKey },
      toNodeId: holderA.nodeId,
      prevHash: await iouHash(iouA),
      swapPairHash: await swapPairHash(pair),
      endorsedAt: NOW + 2_000,
      nonce: crypto.randomUUID(),
    }, holderA.sign);
    await expect(verifySwapBundle(
      pair,
      [intentA, intentB],
      [{ iou: iouA, chain: [wrong] }, legB],
      bundleOptions()
    )).resolves.toEqual({ ok: false, reason: 'chain-broken' });
  });

  it('條件背書自己的簽章無效時回 bad-signature', async () => {
    const { pair, intentA, intentB, legA, legB } = await scenario();
    const last = legA.chain[0];
    const forgedLeg = {
      ...legA,
      chain: [{ ...last, signature: `${last.signature}A` }],
    };
    await expect(verifySwapBundle(
      pair, [intentA, intentB], [forgedLeg, legB], bundleOptions()
    )).resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });
});
