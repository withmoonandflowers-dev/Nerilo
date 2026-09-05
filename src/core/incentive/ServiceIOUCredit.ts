/**
 * Protocol Spec 031 的觀測者信用摘要格式、簽驗與既有觀測來源轉接。
 *
 * 摘要只能表達本機實際觀測值。缺少計數來源時填 0，缺少 RTT 時保留 null，
 * 不在此模組建立或推算任何觀測服務。
 */
import type { HeartbeatService } from '../mesh/HeartbeatService';
import type { CourierQualityStore } from '../relay/CourierQuality';
import { ecdsaVerifier, pubKeyBindsNodeId } from '../relay/CourierReceipts';
import type { SignFn } from './CoSignedReceipt';
import type { ServiceIOUParty, ServiceIOURejectReason } from './ServiceIOU';

export interface CreditSummaryWindow {
  fromMs: number;
  toMs: number;
}

export interface CreditObservations {
  connectionAttempts: number;
  connectionSuccesses: number;
  reconcileAttempts: number;
  reconcileSuccesses: number;
  continuousReachableMs: number;
  consecutiveFailures: number;
  meshRttMsLatest: number | null;
  redeemRequests: number;
  redeemHonoured: number;
  doubleEndorsementsObserved: number;
}

export interface UnsignedServiceCreditSummary {
  v: 'ncred1';
  subjectNodeId: string;
  observer: ServiceIOUParty;
  window: CreditSummaryWindow;
  observations: CreditObservations;
  issuedAt: number;
  nonce: string;
}

export interface ServiceCreditSummary extends UnsignedServiceCreditSummary {
  signature: string;
}

export type ServiceCreditSummaryValidation =
  | { ok: true; summary: ServiceCreditSummary }
  | { ok: false; reason: ServiceIOURejectReason };

export interface CreditObservationSources {
  courierQualityStore?: Pick<CourierQualityStore, 'get'>;
  heartbeatService?: Pick<HeartbeatService, 'getLatency'>;
  redemptionInteractions?: Pick<CreditObservations, 'redeemRequests' | 'redeemHonoured'>;
  endorsementRegistry?: { evidenceFor(fromNodeId: string): readonly unknown[] };
}

const SERVICE_CREDIT_VERSION = 'ncred1';
const CREDIT_CLOCK_SKEW_MS = 30_000;
const INTEGER_OBSERVATION_KEYS = [
  'connectionAttempts',
  'connectionSuccesses',
  'reconcileAttempts',
  'reconcileSuccesses',
  'continuousReachableMs',
  'consecutiveFailures',
  'redeemRequests',
  'redeemHonoured',
  'doubleEndorsementsObserved',
] as const satisfies readonly (keyof CreditObservations)[];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonce(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return atob(padded).length >= 16;
  } catch {
    return false;
  }
}

function isParty(value: unknown): value is ServiceIOUParty {
  if (!value || typeof value !== 'object') return false;
  const party = value as Partial<ServiceIOUParty>;
  return isNonEmptyString(party.nodeId) && isNonEmptyString(party.pubKey);
}

function hasCreditSummaryShape(value: unknown): value is ServiceCreditSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<ServiceCreditSummary>;
  const window = summary.window as Partial<CreditSummaryWindow> | undefined;
  const observations = summary.observations as Partial<CreditObservations> | undefined;
  return summary.v === SERVICE_CREDIT_VERSION
    && isNonEmptyString(summary.subjectNodeId)
    && isParty(summary.observer)
    && !!window
    && typeof window.fromMs === 'number'
    && typeof window.toMs === 'number'
    && !!observations
    && INTEGER_OBSERVATION_KEYS.every((key) => typeof observations[key] === 'number')
    && (observations.meshRttMsLatest === null
      || typeof observations.meshRttMsLatest === 'number')
    && typeof summary.issuedAt === 'number'
    && isNonce(summary.nonce)
    && isNonEmptyString(summary.signature);
}

function creditSummaryCanonical(summary: UnsignedServiceCreditSummary): string {
  return JSON.stringify([
    'NERILO-SERVICE-CREDIT',
    SERVICE_CREDIT_VERSION,
    summary.subjectNodeId,
    summary.observer.nodeId,
    summary.observer.pubKey,
    summary.window.fromMs,
    summary.window.toMs,
    summary.observations.connectionAttempts,
    summary.observations.connectionSuccesses,
    summary.observations.reconcileAttempts,
    summary.observations.reconcileSuccesses,
    summary.observations.continuousReachableMs,
    summary.observations.consecutiveFailures,
    summary.observations.meshRttMsLatest,
    summary.observations.redeemRequests,
    summary.observations.redeemHonoured,
    summary.observations.doubleEndorsementsObserved,
    summary.issuedAt,
    summary.nonce,
  ]);
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasValidNumbers(summary: ServiceCreditSummary): boolean {
  return isNonNegativeInteger(summary.window.fromMs)
    && isNonNegativeInteger(summary.window.toMs)
    && summary.window.fromMs <= summary.window.toMs
    && isNonNegativeInteger(summary.issuedAt)
    && INTEGER_OBSERVATION_KEYS.every((key) => (
      isNonNegativeInteger(summary.observations[key] as number)
    ))
    && (summary.observations.meshRttMsLatest === null
      || isNonNegativeInteger(summary.observations.meshRttMsLatest));
}

export async function createCreditSummary(
  summary: UnsignedServiceCreditSummary,
  observerSign: SignFn
): Promise<ServiceCreditSummary> {
  return {
    ...summary,
    signature: await observerSign(creditSummaryCanonical(summary)),
  };
}

export async function verifyCreditSummary(
  value: unknown,
  options: { now: number }
): Promise<ServiceCreditSummaryValidation> {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' };
  if ((value as { v?: unknown }).v !== SERVICE_CREDIT_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!hasCreditSummaryShape(value)) return { ok: false, reason: 'malformed' };
  const summary = value;
  try {
    if (!(await pubKeyBindsNodeId(summary.observer.nodeId, summary.observer.pubKey))) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    const verify = await ecdsaVerifier(summary.observer.pubKey);
    const { signature, ...unsigned } = summary;
    if (!(await verify(creditSummaryCanonical(unsigned), signature))) {
      return { ok: false, reason: 'bad-signature' };
    }
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (summary.observer.nodeId === summary.subjectNodeId) {
    return { ok: false, reason: 'malformed' };
  }
  if (!hasValidNumbers(summary)) return { ok: false, reason: 'malformed' };
  if (summary.issuedAt > options.now + CREDIT_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, summary: structuredClone(summary) };
}

function nonNegativeIntegerOrZero(value: unknown): number {
  return typeof value === 'number' && isNonNegativeInteger(value) ? value : 0;
}

function latestRttOrNull(value: unknown): number | null {
  return typeof value === 'number' && isNonNegativeInteger(value) ? value : null;
}

export function buildCreditObservations(
  subjectNodeId: string,
  sources: CreditObservationSources
): CreditObservations {
  let quality: ReturnType<NonNullable<CreditObservationSources['courierQualityStore']>['get']>;
  try {
    quality = sources.courierQualityStore?.get(subjectNodeId);
  } catch {
    quality = undefined;
  }

  let meshRttMsLatest: number | null = null;
  try {
    meshRttMsLatest = latestRttOrNull(
      sources.heartbeatService?.getLatency(subjectNodeId)
    );
  } catch {
    meshRttMsLatest = null;
  }

  let redeemRequests = 0;
  let redeemHonoured = 0;
  redeemRequests = nonNegativeIntegerOrZero(
    sources.redemptionInteractions?.redeemRequests
  );
  redeemHonoured = nonNegativeIntegerOrZero(
    sources.redemptionInteractions?.redeemHonoured
  );

  let doubleEndorsementsObserved = 0;
  try {
    doubleEndorsementsObserved = nonNegativeIntegerOrZero(
      sources.endorsementRegistry?.evidenceFor(subjectNodeId).length
    );
  } catch {
    doubleEndorsementsObserved = 0;
  }

  return {
    connectionAttempts: nonNegativeIntegerOrZero(quality?.connectionAttempts),
    connectionSuccesses: nonNegativeIntegerOrZero(quality?.connectionSuccesses),
    reconcileAttempts: nonNegativeIntegerOrZero(quality?.reconcileAttempts),
    reconcileSuccesses: nonNegativeIntegerOrZero(quality?.reconcileSuccesses),
    continuousReachableMs: nonNegativeIntegerOrZero(quality?.continuousReachableMs),
    consecutiveFailures: nonNegativeIntegerOrZero(quality?.consecutiveFailures),
    meshRttMsLatest,
    redeemRequests,
    redeemHonoured,
    doubleEndorsementsObserved,
  };
}
