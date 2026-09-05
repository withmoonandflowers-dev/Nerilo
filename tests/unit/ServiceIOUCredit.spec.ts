/**
 * Protocol Spec 031 D5：觀測者信用摘要與既有觀測來源轉接。
 * @vitest-environment node
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import { HeartbeatService } from '../../src/core/mesh/HeartbeatService';
import { CourierQualityStore } from '../../src/core/relay/CourierQuality';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import type { SignFn } from '../../src/core/incentive/CoSignedReceipt';
import {
  buildCreditObservations,
  createCreditSummary,
  verifyCreditSummary,
  type CreditObservations,
  type UnsignedServiceCreditSummary,
} from '../../src/core/incentive/ServiceIOUCredit';
import type { ServiceIOUParty } from '../../src/core/incentive/ServiceIOU';

const NOW = 1_788_900_000_000;

interface Party extends ServiceIOUParty {
  sign: SignFn;
}

let observer: Party;
let subject: Party;
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

function publicParty(value: Party): ServiceIOUParty {
  return { nodeId: value.nodeId, pubKey: value.pubKey };
}

beforeAll(async () => {
  [observer, subject, attacker] = await Promise.all([
    party(), party(), party(),
  ]);
});

function observations(overrides: Partial<CreditObservations> = {}): CreditObservations {
  return {
    connectionAttempts: 12,
    connectionSuccesses: 11,
    reconcileAttempts: 9,
    reconcileSuccesses: 9,
    continuousReachableMs: 3_600_000,
    consecutiveFailures: 0,
    meshRttMsLatest: 84,
    redeemRequests: 4,
    redeemHonoured: 4,
    doubleEndorsementsObserved: 0,
    ...overrides,
  };
}

function unsignedSummary(
  overrides: Partial<UnsignedServiceCreditSummary> = {}
): UnsignedServiceCreditSummary {
  return {
    v: 'ncred1',
    subjectNodeId: subject.nodeId,
    observer: publicParty(observer),
    window: { fromMs: NOW - 100_000, toMs: NOW },
    observations: observations(),
    issuedAt: NOW + 1_000,
    nonce: crypto.randomUUID(),
    ...overrides,
  };
}

describe('ServiceIOUCredit D5 正向路徑', () => {
  it('觀測者簽署的合法摘要可驗', async () => {
    const summary = await createCreditSummary(unsignedSummary(), observer.sign);

    const result = await verifyCreditSummary(summary, { now: NOW + 2_000 });

    expect(result).toEqual({ ok: true, summary });
    expect(summary.observer.nodeId).toBe(observer.nodeId);
    expect(summary.observer.nodeId).not.toBe(summary.subjectNodeId);
  });

  it('meshRttMsLatest 為 null 時可驗且不會被補成 0', async () => {
    const summary = await createCreditSummary(unsignedSummary({
      observations: observations({ meshRttMsLatest: null }),
    }), observer.sign);

    const result = await verifyCreditSummary(summary, { now: NOW + 2_000 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.summary.observations.meshRttMsLatest).toBeNull();
    expect(summary.observations.meshRttMsLatest).toBeNull();
  });

  it('既有四種來源有值時逐欄組成觀測資料', async () => {
    let clock = NOW;
    const quality = new CourierQualityStore(() => clock);
    quality.recordConnection(subject.nodeId, true, 20);
    clock += 400;
    quality.recordReconcile(subject.nodeId, true);
    const heartbeat: Pick<HeartbeatService, 'getLatency'> = { getLatency: () => 84 };

    const built = buildCreditObservations(subject.nodeId, {
      courierQualityStore: quality,
      heartbeatService: heartbeat,
      redemptionInteractions: { redeemRequests: 2, redeemHonoured: 1 },
      endorsementRegistry: { evidenceFor: () => [{}, {}] },
    });

    expect(built).toEqual({
      connectionAttempts: 1,
      connectionSuccesses: 1,
      reconcileAttempts: 1,
      reconcileSuccesses: 1,
      continuousReachableMs: 400,
      consecutiveFailures: 0,
      meshRttMsLatest: 84,
      redeemRequests: 2,
      redeemHonoured: 1,
      doubleEndorsementsObserved: 2,
    });
  });

  it('缺少品質、RTT、兌換與證據來源時只使用明定的零值與 null', () => {
    const quality = new CourierQualityStore();
    const heartbeat: Pick<HeartbeatService, 'getLatency'> = { getLatency: () => null };

    expect(buildCreditObservations(subject.nodeId, {
      courierQualityStore: quality,
      heartbeatService: heartbeat,
    })).toEqual({
      connectionAttempts: 0,
      connectionSuccesses: 0,
      reconcileAttempts: 0,
      reconcileSuccesses: 0,
      continuousReachableMs: 0,
      consecutiveFailures: 0,
      meshRttMsLatest: null,
      redeemRequests: 0,
      redeemHonoured: 0,
      doubleEndorsementsObserved: 0,
    });
  });
});

describe('ServiceIOUCredit D5 負向路徑', () => {
  it('observer 公鑰與 nodeId 不綁定回 identity-mismatch', async () => {
    const summary = await createCreditSummary(unsignedSummary(), observer.sign);

    await expect(verifyCreditSummary({
      ...summary,
      observer: { ...summary.observer, pubKey: attacker.pubKey },
    }, { now: NOW + 2_000 })).resolves.toEqual({
      ok: false,
      reason: 'identity-mismatch',
    });
  });

  it('任一簽章覆蓋欄位被改動回 bad-signature', async () => {
    const summary = await createCreditSummary(unsignedSummary(), observer.sign);

    await expect(verifyCreditSummary({
      ...summary,
      subjectNodeId: attacker.nodeId,
    }, { now: NOW + 2_000 })).resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('未知版本回 unsupported-version', async () => {
    const summary = await createCreditSummary(unsignedSummary(), observer.sign);

    await expect(verifyCreditSummary({ ...summary, v: 'ncred2' }, { now: NOW + 2_000 }))
      .resolves.toEqual({ ok: false, reason: 'unsupported-version' });
  });

  it('被評價的開票人自簽摘要仍視為未驗證資料', async () => {
    const summary = await createCreditSummary(unsignedSummary({
      observer: publicParty(subject),
    }), subject.sign);

    await expect(verifyCreditSummary(summary, { now: NOW + 2_000 }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('觀測窗起點晚於終點回 malformed', async () => {
    const summary = await createCreditSummary(unsignedSummary({
      window: { fromMs: NOW + 1, toMs: NOW },
    }), observer.sign);

    await expect(verifyCreditSummary(summary, { now: NOW + 2_000 }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('負數觀測值回 malformed', async () => {
    const summary = await createCreditSummary(unsignedSummary({
      observations: observations({ redeemRequests: -1 }),
    }), observer.sign);

    await expect(verifyCreditSummary(summary, { now: NOW + 2_000 }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('非整數觀測值回 malformed', async () => {
    const summary = await createCreditSummary(unsignedSummary({
      observations: observations({ meshRttMsLatest: 1.5 }),
    }), observer.sign);

    await expect(verifyCreditSummary(summary, { now: NOW + 2_000 }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('issuedAt 超過驗證時點加 30 秒回 malformed', async () => {
    const summary = await createCreditSummary(unsignedSummary({
      issuedAt: NOW + 30_001,
    }), observer.sign);

    await expect(verifyCreditSummary(summary, { now: NOW }))
      .resolves.toEqual({ ok: false, reason: 'malformed' });
  });
});
