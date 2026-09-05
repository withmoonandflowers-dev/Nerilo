/**
 * Protocol Spec 031 D4：開票人背書登記、雙重背書證據與代理受理。
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
  endorsementHash,
  iouHash,
  type ServiceDenomination,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOUParty,
} from '../../src/core/incentive/ServiceIOU';
import {
  createSwapIntent,
  createSwapPair,
  swapIntentHash,
  swapPairHash,
  type SwapEndorsementLeg,
  type SwapIntent,
  type SwapPair,
  type UnsignedSwapIntent,
} from '../../src/core/incentive/ServiceIOUMatching';
import {
  IssuerEndorsementRegistry,
  ProxyRegistrationQueue,
  verifyDoubleEndorsementEvidence,
  type EndorsementRegistrationResult,
  type IssuerEndorsementRegistryPersistence,
  type IssuerEndorsementRegistrySnapshot,
  type ProxyPendingReceipt,
  type SwapRegistrationBundle,
} from '../../src/core/incentive/IssuerEndorsementRegistry';

const NOW = 1_788_800_000_000;
const IOU_EXPIRES_AT = NOW + 120_000;
const SWAP_EXPIRES_AT = NOW + 60_000;

interface Party extends ServiceIOUParty {
  sign: SignFn;
}

interface ConditionalScenario {
  iouA: ServiceIOU;
  chainA: ServiceEndorsement[];
  bundle: SwapRegistrationBundle;
}

interface MultiConditionalScenario {
  iou: ServiceIOU;
  chain: ServiceEndorsement[];
  bundles: ReadonlyMap<number, SwapRegistrationBundle>;
}

let issuer: Party;
let otherIssuer: Party;
let holderA: Party;
let holderB: Party;
let holderC: Party;
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

function publicParty(value: Party): ServiceIOUParty {
  return { nodeId: value.nodeId, pubKey: value.pubKey };
}

beforeAll(async () => {
  [issuer, otherIssuer, holderA, holderB, holderC, matcher] = await Promise.all([
    party(), party(), party(), party(), party(), party(),
  ]);
});

async function makeIOU(options: {
  issuer?: Party;
  holder?: Party;
  iouId?: string;
  denomination?: ServiceDenomination;
  expiresAt?: number;
} = {}): Promise<ServiceIOU> {
  const issuingParty = options.issuer ?? issuer;
  const initialHolder = options.holder ?? holderA;
  return createServiceIOU({
    v: 'nsiou1',
    iouId: options.iouId ?? crypto.randomUUID(),
    kind: 'endorsable',
    issuer: publicParty(issuingParty),
    holder: publicParty(initialHolder),
    denomination: options.denomination ?? { unit: 'relay-bytes', amount: 10 },
    issuedAt: NOW,
    expiresAt: options.expiresAt ?? IOU_EXPIRES_AT,
    nonce: crypto.randomUUID(),
  }, issuingParty.sign);
}

async function appendEndorsement(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  from: Party,
  to: Party,
  options: { swapPairHash?: string | null; endorsedAt?: number } = {}
): Promise<ServiceEndorsement> {
  const previousHash = chain.length === 0
    ? await iouHash(iou)
    : await endorsementHash(chain[chain.length - 1]);
  return createEndorsement({
    v: 'nsend1',
    iouId: iou.iouId,
    seq: chain.length + 1,
    from: publicParty(from),
    toNodeId: to.nodeId,
    prevHash: previousHash,
    swapPairHash: options.swapPairHash ?? null,
    endorsedAt: options.endorsedAt ?? NOW + 1_000 + chain.length,
    nonce: crypto.randomUUID(),
  }, from.sign);
}

async function oneHop(
  iou: ServiceIOU,
  to: Party = holderB
): Promise<ServiceEndorsement[]> {
  return [await appendEndorsement(iou, [], holderA, to)];
}

async function makeIntent(
  iou: ServiceIOU,
  holder: Party,
  want: UnsignedSwapIntent['want']
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
    wantIssuers: null,
    holder: publicParty(holder),
    expiresAt: SWAP_EXPIRES_AT,
    nonce: crypto.randomUUID(),
  }, holder.sign);
}

async function conditionalScenario(): Promise<ConditionalScenario> {
  const iouA = await makeIOU({ denomination: { unit: 'relay-bytes', amount: 10 } });
  const iouB = await makeIOU({
    issuer: otherIssuer,
    holder: holderB,
    denomination: { unit: 'custody-byte-days', amount: 20 },
  });
  const intentA = await makeIntent(
    iouA,
    holderA,
    { unit: 'custody-byte-days', minAmount: 20 }
  );
  const intentB = await makeIntent(iouB, holderB, { unit: 'relay-bytes', minAmount: 10 });
  const pair: SwapPair = await createSwapPair({
    v: 'nswappair1',
    pairId: crypto.randomUUID(),
    intentHashes: await Promise.all([swapIntentHash(intentA), swapIntentHash(intentB)]),
    matcher: publicParty(matcher),
    proposedAt: NOW + 1_000,
    expiresAt: SWAP_EXPIRES_AT,
    nonce: crypto.randomUUID(),
  }, matcher.sign);
  const pairHash = await swapPairHash(pair);
  const chainA = [await appendEndorsement(iouA, [], holderA, holderB, {
    swapPairHash: pairHash,
    endorsedAt: NOW + 2_000,
  })];
  const chainB = [await appendEndorsement(iouB, [], holderB, holderA, {
    swapPairHash: pairHash,
    endorsedAt: NOW + 2_000,
  })];
  const legA: SwapEndorsementLeg = { iou: iouA, chain: chainA };
  const legB: SwapEndorsementLeg = { iou: iouB, chain: chainB };
  return {
    iouA,
    chainA,
    bundle: { pair, intents: [intentA, intentB], endorsements: [legA, legB] },
  };
}

async function multiConditionalScenario(): Promise<MultiConditionalScenario> {
  const iouA = await makeIOU({ denomination: { unit: 'relay-bytes', amount: 10 } });
  const iouB = await makeIOU({
    issuer: otherIssuer,
    holder: holderB,
    denomination: { unit: 'custody-byte-days', amount: 20 },
  });
  const firstIntentA = await makeIntent(
    iouA,
    holderA,
    { unit: 'custody-byte-days', minAmount: 20 }
  );
  const firstIntentB = await makeIntent(iouB, holderB, { unit: 'relay-bytes', minAmount: 10 });
  const firstPair = await createSwapPair({
    v: 'nswappair1',
    pairId: crypto.randomUUID(),
    intentHashes: await Promise.all([
      swapIntentHash(firstIntentA),
      swapIntentHash(firstIntentB),
    ]),
    matcher: publicParty(matcher),
    proposedAt: NOW + 1_000,
    expiresAt: SWAP_EXPIRES_AT,
    nonce: crypto.randomUUID(),
  }, matcher.sign);
  const firstPairHash = await swapPairHash(firstPair);
  const firstEndorsement = await appendEndorsement(iouA, [], holderA, holderB, {
    swapPairHash: firstPairHash,
    endorsedAt: NOW + 2_000,
  });
  const firstCounterpart = await appendEndorsement(iouB, [], holderB, holderA, {
    swapPairHash: firstPairHash,
    endorsedAt: NOW + 2_000,
  });
  const firstBundle: SwapRegistrationBundle = {
    pair: firstPair,
    intents: [firstIntentA, firstIntentB],
    endorsements: [
      { iou: iouA, chain: [firstEndorsement] },
      { iou: iouB, chain: [firstCounterpart] },
    ],
  };

  const iouC = await makeIOU({
    issuer: otherIssuer,
    holder: holderC,
    denomination: { unit: 'priority', amount: 2 },
  });
  const secondIntentA = await makeIntent(iouA, holderB, { unit: 'priority', minAmount: 2 });
  const secondIntentC = await makeIntent(iouC, holderC, { unit: 'relay-bytes', minAmount: 10 });
  const secondPair = await createSwapPair({
    v: 'nswappair1',
    pairId: crypto.randomUUID(),
    intentHashes: await Promise.all([
      swapIntentHash(secondIntentA),
      swapIntentHash(secondIntentC),
    ]),
    matcher: publicParty(matcher),
    proposedAt: NOW + 2_500,
    expiresAt: SWAP_EXPIRES_AT,
    nonce: crypto.randomUUID(),
  }, matcher.sign);
  const secondPairHash = await swapPairHash(secondPair);
  const secondEndorsement = await appendEndorsement(
    iouA,
    [firstEndorsement],
    holderB,
    holderC,
    { swapPairHash: secondPairHash, endorsedAt: NOW + 3_000 }
  );
  const secondCounterpart = await appendEndorsement(iouC, [], holderC, holderB, {
    swapPairHash: secondPairHash,
    endorsedAt: NOW + 3_000,
  });
  const secondBundle: SwapRegistrationBundle = {
    pair: secondPair,
    intents: [secondIntentA, secondIntentC],
    endorsements: [
      { iou: iouA, chain: [firstEndorsement, secondEndorsement] },
      { iou: iouC, chain: [secondCounterpart] },
    ],
  };
  return {
    iou: iouA,
    chain: [firstEndorsement, secondEndorsement],
    bundles: new Map([
      [1, firstBundle],
      [2, secondBundle],
    ]),
  };
}

class MemoryPersistence implements IssuerEndorsementRegistryPersistence {
  snapshot: IssuerEndorsementRegistrySnapshot | null = null;

  async load(_issuerNodeId: string): Promise<IssuerEndorsementRegistrySnapshot | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(snapshot: IssuerEndorsementRegistrySnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

describe('IssuerEndorsementRegistry D4 正向路徑', () => {
  it('首次登記接受合法鏈並建立鏈頭', async () => {
    const iou = await makeIOU();
    const chain = await oneHop(iou);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    const result = await registry.register(iou, chain, { now: NOW + 3_000 });

    expect(result).toEqual({
      status: 'accepted',
      changed: true,
      head: {
        seq: 1,
        endorsementHash: await endorsementHash(chain[0]),
        toNodeId: holderB.nodeId,
      },
    });
    expect(registry.registrationCount()).toBe(1);
  });

  it('共同前綴完全相同的延長鏈被接受並前移鏈頭', async () => {
    const iou = await makeIOU();
    const first = await oneHop(iou);
    const second = await appendEndorsement(iou, first, holderB, holderC);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);
    await registry.register(iou, first, { now: NOW + 3_000 });

    const result = await registry.register(iou, [...first, second], { now: NOW + 3_000 });

    expect(result).toEqual({
      status: 'accepted',
      changed: true,
      head: {
        seq: 2,
        endorsementHash: await endorsementHash(second),
        toNodeId: holderC.nodeId,
      },
    });
  });

  it('完全相同的鏈重送為冪等且不產生第二筆登記', async () => {
    const iou = await makeIOU();
    const chain = await oneHop(iou);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);
    const first = await registry.register(iou, chain, { now: NOW + 3_000 });

    const resend = await registry.register(iou, chain, { now: NOW + 3_000 });

    expect(resend).toEqual({ ...first, changed: false });
    expect(registry.registrationCount()).toBe(1);
    expect(registry.evidence()).toEqual([]);
  });

  it('嚴格舊前綴重送為冪等且不倒退鏈頭', async () => {
    const iou = await makeIOU();
    const first = await oneHop(iou);
    const second = await appendEndorsement(iou, first, holderB, holderC);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);
    await registry.register(iou, [...first, second], { now: NOW + 3_000 });

    const result = await registry.register(iou, first, { now: NOW + 3_000 });

    expect(result).toMatchObject({ status: 'accepted', changed: false });
    expect(registry.headFor(iou.iouId)?.seq).toBe(2);
    expect(result.status === 'accepted' && result.head.seq).toBe(2);
  });

  it('成對且綁定相同配對的條件背書可登記', async () => {
    const { iouA, chainA, bundle } = await conditionalScenario();
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    const result = await registry.register(iouA, chainA, {
      now: NOW + 3_000,
      swapBundles: new Map([[1, bundle]]),
    });

    expect(result).toMatchObject({ status: 'accepted', changed: true });
  });

  it('代理回傳待裁決收據並依受理順序轉交', async () => {
    const iou = await makeIOU();
    const first = await oneHop(iou);
    const second = await appendEndorsement(iou, first, holderB, holderC);
    const proxy = new ProxyRegistrationQueue(() => NOW + 10);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    const firstReceipt = proxy.enqueue(iou, first);
    const secondReceipt = proxy.enqueue(iou, [...first, second]);

    expectTypeOf(firstReceipt).toEqualTypeOf<ProxyPendingReceipt>();
    expectTypeOf(firstReceipt).not.toEqualTypeOf<EndorsementRegistrationResult>();
    expect(firstReceipt).toEqual({
      status: 'pending-issuer-decision',
      sequence: 1,
      receivedAt: NOW + 10,
    });
    expect(firstReceipt).not.toHaveProperty('accepted');
    expect(secondReceipt.sequence).toBe(2);
    const decisions = await proxy.forwardTo(registry, { now: NOW + 3_000 });
    expect(decisions.map(({ sequence, decision }) => [sequence, decision.status])).toEqual([
      [1, 'accepted'],
      [2, 'accepted'],
    ]);
    expect(registry.headFor(iou.iouId)?.seq).toBe(2);
  });

  it('注入的持久化可還原已登記鏈頭', async () => {
    const iou = await makeIOU();
    const chain = await oneHop(iou);
    const persistence = new MemoryPersistence();
    const firstRegistry = new IssuerEndorsementRegistry(issuer.nodeId, persistence);
    await firstRegistry.register(iou, chain, { now: NOW + 3_000 });
    await expect(firstRegistry.flush()).resolves.toBe(true);

    const restored = new IssuerEndorsementRegistry(issuer.nodeId, persistence);
    await restored.hydrate({ now: NOW + 3_000 });

    expect(restored.headFor(iou.iouId)).toEqual(firstRegistry.headFor(iou.iouId));
    expect(restored.registrationCount()).toBe(1);
  });
});

describe('IssuerEndorsementRegistry D4 負向與衝突路徑', () => {
  it('同 seq 分岔時後到者被拒並留下可獨立驗證的兩則證據', async () => {
    const iou = await makeIOU();
    const registered = await oneHop(iou, holderB);
    const conflicting = await oneHop(iou, holderC);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);
    await registry.register(iou, registered, { now: NOW + 3_000 });

    const result = await registry.register(iou, conflicting, { now: NOW + 3_000 });
    const [evidence] = registry.evidence();

    expect(result).toEqual({ status: 'rejected', reason: 'already-endorsed-elsewhere' });
    expect(evidence).toMatchObject({
      iouId: iou.iouId,
      seq: 1,
      fromNodeId: holderA.nodeId,
    });
    await expect(verifyDoubleEndorsementEvidence(
      evidence.registered,
      evidence.conflicting
    )).resolves.toBe(true);
    expect(registry.evidenceFor(holderA.nodeId)).toHaveLength(1);
  });

  it('兩則背書去向相同時不構成可轉移的雙重背書證據', async () => {
    const iou = await makeIOU();
    const first = (await oneHop(iou, holderB))[0];
    const second = await appendEndorsement(iou, [], holderA, holderB);

    await expect(verifyDoubleEndorsementEvidence(first, second)).resolves.toBe(false);
  });

  it('非本節點開出的憑證回 unknown-iou', async () => {
    const iou = await makeIOU({ issuer: otherIssuer });
    const chain = await oneHop(iou);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    await expect(registry.register(iou, chain, { now: NOW + 3_000 })).resolves.toEqual({
      status: 'rejected',
      reason: 'unknown-iou',
    });
  });

  it('到期憑證回 expired', async () => {
    const iou = await makeIOU({ expiresAt: NOW + 2_000 });
    const chain = await oneHop(iou);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    await expect(registry.register(iou, chain, { now: NOW + 2_001 })).resolves.toEqual({
      status: 'rejected',
      reason: 'expired',
    });
  });

  it('條件背書單方送達回 swap-incomplete', async () => {
    const { iouA, chainA } = await conditionalScenario();
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    await expect(registry.register(iouA, chainA, { now: NOW + 3_000 })).resolves.toEqual({
      status: 'rejected',
      reason: 'swap-incomplete',
    });
  });

  it('條件背書超過配對時限回 swap-expired', async () => {
    const { iouA, chainA, bundle } = await conditionalScenario();
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    await expect(registry.register(iouA, chainA, {
      now: SWAP_EXPIRES_AT + 1,
      swapBundles: new Map([[1, bundle]]),
    })).resolves.toEqual({ status: 'rejected', reason: 'swap-expired' });
  });

  it('兩則新條件背書缺一份 bundle 時拒絕，附齊後接受且已涵蓋者免重附', async () => {
    const { iou, chain, bundles } = await multiConditionalScenario();
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    await expect(registry.register(iou, chain, {
      now: NOW + 4_000,
      swapBundles: new Map([[1, bundles.get(1)!]]),
    })).resolves.toEqual({ status: 'rejected', reason: 'swap-incomplete' });
    await expect(registry.register(iou, chain, {
      now: NOW + 4_000,
      swapBundles: bundles,
    })).resolves.toMatchObject({ status: 'accepted', changed: true });
    expect(registry.headFor(iou.iouId)?.seq).toBe(2);

    const ordinaryExtension = await appendEndorsement(iou, chain, holderC, matcher);
    await expect(registry.register(iou, [...chain, ordinaryExtension], {
      now: NOW + 4_000,
    })).resolves.toMatchObject({ status: 'accepted', changed: true });
    expect(registry.headFor(iou.iouId)?.seq).toBe(3);
  });

  it('登記已存在時斷鏈仍回 chain-broken，不被衝突原因蓋掉', async () => {
    const iou = await makeIOU();
    const registered = await oneHop(iou, holderB);
    const conflicting = await oneHop(iou, holderC);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);
    await registry.register(iou, registered, { now: NOW + 3_000 });
    const broken = [{ ...conflicting[0], prevHash: '0'.repeat(64) }];

    await expect(registry.register(iou, broken, { now: NOW + 3_000 })).resolves.toEqual({
      status: 'rejected',
      reason: 'chain-broken',
    });
    expect(registry.evidence()).toEqual([]);
  });

  it('登記已存在時簽章造假仍回 bad-signature，不被衝突原因蓋掉', async () => {
    const iou = await makeIOU();
    const registered = await oneHop(iou, holderB);
    const conflicting = await oneHop(iou, holderC);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);
    await registry.register(iou, registered, { now: NOW + 3_000 });
    const forged = [{ ...conflicting[0], signature: registered[0].signature }];

    await expect(registry.register(iou, forged, { now: NOW + 3_000 })).resolves.toEqual({
      status: 'rejected',
      reason: 'bad-signature',
    });
    expect(registry.evidence()).toEqual([]);
  });

  it('兩個代理各自受理分岔鏈後只有先轉交者被開票人接受', async () => {
    const iou = await makeIOU();
    const chainA = await oneHop(iou, holderB);
    const chainB = await oneHop(iou, holderC);
    const proxyA = new ProxyRegistrationQueue(() => NOW + 10);
    const proxyB = new ProxyRegistrationQueue(() => NOW + 20);
    const registry = new IssuerEndorsementRegistry(issuer.nodeId);

    expect(proxyA.enqueue(iou, chainA).status).toBe('pending-issuer-decision');
    expect(proxyB.enqueue(iou, chainB).status).toBe('pending-issuer-decision');
    const [decisionA] = await proxyA.forwardTo(registry, { now: NOW + 3_000 });
    const [decisionB] = await proxyB.forwardTo(registry, { now: NOW + 3_000 });

    expect(decisionA.decision.status).toBe('accepted');
    expect(decisionB.decision).toEqual({
      status: 'rejected',
      reason: 'already-endorsed-elsewhere',
    });
  });

  it('竄改任一證據簽章後無法通過獨立驗證', async () => {
    const iou = await makeIOU();
    const registered = (await oneHop(iou, holderB))[0];
    const conflicting = (await oneHop(iou, holderC))[0];
    const tampered = { ...conflicting, signature: registered.signature };

    await expect(verifyDoubleEndorsementEvidence(registered, tampered)).resolves.toBe(false);
  });
});
