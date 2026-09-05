/**
 * Protocol Spec 031 D1：服務債權憑證、面額與背書鏈符合性向量。
 * @vitest-environment node
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import {
  createEndorsement,
  createServiceIOU,
  endorsementHash,
  iouHash,
  verifyEndorsementChain,
  verifyServiceIOU,
  type ServiceDenomination,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOUParty,
  type UnsignedServiceEndorsement,
  type UnsignedServiceIOU,
} from '../../src/core/incentive/ServiceIOU';
import type { SignFn } from '../../src/core/incentive/CoSignedReceipt';

const NOW = 1_788_700_000_000;
const EXPIRES_AT = NOW + 3_600_000;
const IOU_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const ENDORSEMENT_NONCES = [
  'BBBBBBBBBBBBBBBBBBBBBB',
  'CCCCCCCCCCCCCCCCCCCCCC',
  'DDDDDDDDDDDDDDDDDDDDDD',
];

interface Party extends ServiceIOUParty {
  sign: SignFn;
}

let issuer: Party;
let firstHolder: Party;
let secondHolder: Party;
let thirdHolder: Party;
let fourthHolder: Party;
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
  [issuer, firstHolder, secondHolder, thirdHolder, fourthHolder, attacker] = await Promise.all([
    party(), party(), party(), party(), party(), party(),
  ]);
});

function unsignedIOU(overrides: Partial<UnsignedServiceIOU> = {}): UnsignedServiceIOU {
  return {
    v: 'nsiou1',
    iouId: 'iou-031-1',
    kind: 'endorsable',
    issuer: { nodeId: issuer.nodeId, pubKey: issuer.pubKey },
    holder: { nodeId: firstHolder.nodeId, pubKey: firstHolder.pubKey },
    denomination: { unit: 'relay-bytes', amount: 5_242_880 },
    issuedAt: NOW,
    expiresAt: EXPIRES_AT,
    nonce: IOU_NONCE,
    ...overrides,
  };
}

async function serviceIOU(overrides: Partial<UnsignedServiceIOU> = {}): Promise<ServiceIOU> {
  return createServiceIOU(unsignedIOU(overrides), issuer.sign);
}

async function endorsement(
  input: Omit<UnsignedServiceEndorsement, 'v' | 'iouId'>,
  sign: SignFn,
  iouId = 'iou-031-1'
): Promise<ServiceEndorsement> {
  return createEndorsement({ v: 'nsend1', iouId, ...input }, sign);
}

async function chainOfThree(iou: ServiceIOU): Promise<ServiceEndorsement[]> {
  const first = await endorsement({
    seq: 1,
    from: { nodeId: firstHolder.nodeId, pubKey: firstHolder.pubKey },
    toNodeId: secondHolder.nodeId,
    prevHash: await iouHash(iou),
    swapPairHash: null,
    endorsedAt: NOW + 3_000,
    nonce: ENDORSEMENT_NONCES[0],
  }, firstHolder.sign, iou.iouId);
  const second = await endorsement({
    seq: 2,
    from: { nodeId: secondHolder.nodeId, pubKey: secondHolder.pubKey },
    toNodeId: thirdHolder.nodeId,
    prevHash: await endorsementHash(first),
    swapPairHash: null,
    endorsedAt: NOW + 1_000,
    nonce: ENDORSEMENT_NONCES[1],
  }, secondHolder.sign, iou.iouId);
  const third = await endorsement({
    seq: 3,
    from: { nodeId: thirdHolder.nodeId, pubKey: thirdHolder.pubKey },
    toNodeId: fourthHolder.nodeId,
    prevHash: await endorsementHash(second),
    swapPairHash: null,
    endorsedAt: NOW + 2_000,
    nonce: ENDORSEMENT_NONCES[2],
  }, thirdHolder.sign, iou.iouId);
  return [first, second, third];
}

describe('ServiceIOU C1：nsiou1 憑證', () => {
  it('合法憑證被接受並回傳第一手持有人', async () => {
    const iou = await serviceIOU();
    await expect(verifyServiceIOU(iou, { now: NOW + 1_000 })).resolves.toEqual({
      ok: true,
      holderNodeId: firstHolder.nodeId,
    });
  });

  it('未知版本回 unsupported-version', async () => {
    const iou = await serviceIOU();
    await expect(verifyServiceIOU({ ...iou, v: 'nsiou2' }, { now: NOW + 1_000 }))
      .resolves.toEqual({ ok: false, reason: 'unsupported-version' });
  });

  it('issuer 公鑰與 nodeId 不綁定回 identity-mismatch', async () => {
    const iou = await serviceIOU();
    await expect(verifyServiceIOU({
      ...iou,
      issuer: { ...iou.issuer, pubKey: attacker.pubKey },
    }, { now: NOW + 1_000 })).resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('任一簽章覆蓋欄位被改動回 bad-signature', async () => {
    const iou = await serviceIOU();
    await expect(verifyServiceIOU({ ...iou, iouId: 'iou-tampered' }, { now: NOW + 1_000 }))
      .resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('驗證時點超過 expiresAt 回 expired', async () => {
    const iou = await serviceIOU();
    await expect(verifyServiceIOU(iou, { now: EXPIRES_AT + 1 }))
      .resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('expiresAt 不晚於 issuedAt 回 malformed', async () => {
    const iou = await serviceIOU({ expiresAt: NOW });
    await expect(verifyServiceIOU(iou, { now: NOW }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('ServiceIOU C2：服務面額', () => {
  it.each<ServiceDenomination>([
    { unit: 'relay-bytes', amount: 5_242_880 },
    { unit: 'custody-byte-days', amount: 3_145_728 },
    { unit: 'priority', amount: 2 },
  ])('$unit 可簽可驗', async (denomination) => {
    const iou = await serviceIOU({ denomination });
    await expect(verifyServiceIOU(iou, { now: NOW + 1_000 })).resolves.toMatchObject({ ok: true });
  });

  it('未知 unit 回 unknown-denomination', async () => {
    const iou = await serviceIOU({
      denomination: { unit: 'relay-bytes', amount: 1 },
    });
    const unknown = {
      ...iou,
      denomination: { ...iou.denomination, unit: 'compute-seconds' },
    };
    await expect(verifyServiceIOU(unknown, { now: NOW + 1_000 }))
      .resolves.toEqual({ ok: false, reason: 'unknown-denomination' });
  });

  it.each([-1, 1.5])('amount=%s 回 malformed', async (amount) => {
    const iou = await serviceIOU();
    await expect(verifyServiceIOU({
      ...iou,
      denomination: { ...iou.denomination, amount },
    }, { now: NOW + 1_000 })).resolves.toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('ServiceIOU C3：背書鏈', () => {
  it('長度 3 的合法鏈通過，且 endorsedAt 不必單調遞增', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    await expect(verifyEndorsementChain(iou, chain, { now: NOW + 10_000 })).resolves.toEqual({
      ok: true,
      holderNodeId: fourthHolder.nodeId,
    });
  });

  it('空鏈合法並回傳第一手持有人', async () => {
    const iou = await serviceIOU();
    await expect(verifyEndorsementChain(iou, [], { now: NOW + 1_000 })).resolves.toEqual({
      ok: true,
      holderNodeId: firstHolder.nodeId,
    });
  });

  it('抽掉中間一則回 chain-broken', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    await expect(verifyEndorsementChain(iou, [chain[0], chain[2]], { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'chain-broken' });
  });

  it('改 prevHash 回 chain-broken', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    chain[0] = { ...chain[0], prevHash: '0'.repeat(64) };
    await expect(verifyEndorsementChain(iou, chain, { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'chain-broken' });
  });

  it('背書 iouId 與憑證不符回 chain-broken', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    chain[0] = { ...chain[0], iouId: 'another-iou' };
    await expect(verifyEndorsementChain(iou, chain, { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'chain-broken' });
  });

  it('from 不等於前一則 toNodeId 回 chain-broken', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    chain[1] = { ...chain[1], from: { nodeId: attacker.nodeId, pubKey: attacker.pubKey } };
    await expect(verifyEndorsementChain(iou, chain.slice(0, 2), { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'chain-broken' });
  });

  it.each([
    { first: 1, second: 3, label: '跳號' },
    { first: 1, second: 1, label: '重號' },
  ])('seq $label回 chain-broken', async ({ first, second }) => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    chain[0] = { ...chain[0], seq: first };
    chain[1] = { ...chain[1], seq: second };
    await expect(verifyEndorsementChain(iou, chain.slice(0, 2), { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'chain-broken' });
  });

  it('registered 憑證不能背書', async () => {
    const iou = await serviceIOU({ kind: 'registered' });
    await expect(verifyEndorsementChain(iou, [], { now: NOW + 1_000 }))
      .resolves.toEqual({ ok: false, reason: 'not-endorsable' });
  });

  it('鏈末簽章造假回 bad-signature', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    chain[2] = { ...chain[2], signature: `${chain[2].signature}A` };
    await expect(verifyEndorsementChain(iou, chain, { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('背書人的公鑰與 nodeId 不綁定回 identity-mismatch', async () => {
    const iou = await serviceIOU();
    const forgedIdentity = await endorsement({
      seq: 1,
      from: { nodeId: firstHolder.nodeId, pubKey: attacker.pubKey },
      toNodeId: secondHolder.nodeId,
      prevHash: await iouHash(iou),
      swapPairHash: null,
      endorsedAt: NOW + 1_000,
      nonce: ENDORSEMENT_NONCES[0],
    }, attacker.sign);
    await expect(verifyEndorsementChain(iou, [forgedIdentity], { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('憑證到期後背書鏈回 expired', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    await expect(verifyEndorsementChain(iou, chain, { now: EXPIRES_AT + 1 }))
      .resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('swapPairHash 從 null 改成有值但未重簽回 bad-signature', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    chain[2] = { ...chain[2], swapPairHash: 'f'.repeat(64) };
    await expect(verifyEndorsementChain(iou, chain, { now: NOW + 10_000 }))
      .resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('背書早於開票或晚於 now 加 30 秒回 malformed', async () => {
    const iou = await serviceIOU();
    const base = {
      seq: 1,
      from: { nodeId: firstHolder.nodeId, pubKey: firstHolder.pubKey },
      toNodeId: secondHolder.nodeId,
      prevHash: await iouHash(iou),
      swapPairHash: null,
      nonce: ENDORSEMENT_NONCES[0],
    } satisfies Omit<UnsignedServiceEndorsement, 'v' | 'iouId' | 'endorsedAt'>;
    const beforeIssue = await endorsement({ ...base, endorsedAt: NOW - 1 }, firstHolder.sign);
    const future = await endorsement({ ...base, endorsedAt: NOW + 30_001 }, firstHolder.sign);

    await expect(verifyEndorsementChain(iou, [beforeIssue], { now: NOW }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
    await expect(verifyEndorsementChain(iou, [future], { now: NOW }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('超過呼叫端指定的鏈長上限回 malformed', async () => {
    const iou = await serviceIOU();
    const chain = await chainOfThree(iou);
    await expect(verifyEndorsementChain(iou, chain, { now: NOW + 10_000, maxChainLength: 2 }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });
});
