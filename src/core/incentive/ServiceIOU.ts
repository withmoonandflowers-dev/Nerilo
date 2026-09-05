/**
 * Protocol Spec 031 的服務債權憑證與背書鏈原語。
 *
 * 本檔只處理線上格式、簽章、雜湊與鏈驗證，不碰網路、儲存或 UI。
 */
import type { SignFn } from './CoSignedReceipt';
import { ecdsaVerifier, pubKeyBindsNodeId } from '../relay/CourierReceipts';
import { sha256Hash } from '../../utils/crypto';

export type ServiceDenominationUnit = 'relay-bytes' | 'custody-byte-days' | 'priority';

export interface ServiceDenomination {
  unit: ServiceDenominationUnit;
  amount: number;
}

export interface ServiceIOUParty {
  nodeId: string;
  pubKey: string;
}

export interface UnsignedServiceIOU {
  v: 'nsiou1';
  iouId: string;
  kind: 'registered' | 'endorsable';
  issuer: ServiceIOUParty;
  holder: ServiceIOUParty;
  denomination: ServiceDenomination;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface ServiceIOU extends UnsignedServiceIOU {
  signature: string;
}

export interface UnsignedServiceEndorsement {
  v: 'nsend1';
  iouId: string;
  seq: number;
  from: ServiceIOUParty;
  toNodeId: string;
  prevHash: string;
  swapPairHash: string | null;
  endorsedAt: number;
  nonce: string;
}

export interface ServiceEndorsement extends UnsignedServiceEndorsement {
  signature: string;
}

export type ServiceIOURejectReason =
  | 'unsupported-version'
  | 'malformed'
  | 'identity-mismatch'
  | 'bad-signature'
  | 'expired'
  | 'not-endorsable'
  | 'chain-broken'
  | 'already-endorsed-elsewhere'
  | 'unknown-iou'
  | 'insufficient-balance'
  | 'swap-incomplete'
  | 'swap-expired'
  | 'unknown-denomination';

export type ServiceIOUValidation =
  | { ok: true; holderNodeId: string }
  | { ok: false; reason: ServiceIOURejectReason };

export interface ServiceIOUVerifyOptions {
  now: number;
}

export interface EndorsementChainVerifyOptions extends ServiceIOUVerifyOptions {
  maxChainLength?: number;
}

const SERVICE_IOU_VERSION = 'nsiou1';
const SERVICE_ENDORSEMENT_VERSION = 'nsend1';
const ENDORSEMENT_CLOCK_SKEW_MS = 30_000;

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

function isKnownDenominationUnit(value: unknown): value is ServiceDenominationUnit {
  return value === 'relay-bytes' || value === 'custody-byte-days' || value === 'priority';
}

function hasServiceIOUShape(value: unknown): value is ServiceIOU {
  if (!value || typeof value !== 'object') return false;
  const iou = value as Partial<ServiceIOU>;
  const denomination = iou.denomination as Partial<ServiceDenomination> | undefined;
  return iou.v === SERVICE_IOU_VERSION
    && isNonEmptyString(iou.iouId)
    && (iou.kind === 'registered' || iou.kind === 'endorsable')
    && isParty(iou.issuer)
    && isParty(iou.holder)
    && !!denomination
    && isNonEmptyString(denomination.unit)
    && typeof denomination.amount === 'number'
    && Number.isSafeInteger(denomination.amount)
    && denomination.amount >= 0
    && typeof iou.issuedAt === 'number'
    && Number.isSafeInteger(iou.issuedAt)
    && typeof iou.expiresAt === 'number'
    && Number.isSafeInteger(iou.expiresAt)
    && isNonce(iou.nonce)
    && isNonEmptyString(iou.signature);
}

function hasEndorsementShape(value: unknown): value is ServiceEndorsement {
  if (!value || typeof value !== 'object') return false;
  const endorsement = value as Partial<ServiceEndorsement>;
  return endorsement.v === SERVICE_ENDORSEMENT_VERSION
    && isNonEmptyString(endorsement.iouId)
    && typeof endorsement.seq === 'number'
    && Number.isSafeInteger(endorsement.seq)
    && endorsement.seq >= 1
    && isParty(endorsement.from)
    && isNonEmptyString(endorsement.toNodeId)
    && isNonEmptyString(endorsement.prevHash)
    && (endorsement.swapPairHash === null || isNonEmptyString(endorsement.swapPairHash))
    && typeof endorsement.endorsedAt === 'number'
    && Number.isSafeInteger(endorsement.endorsedAt)
    && isNonce(endorsement.nonce)
    && isNonEmptyString(endorsement.signature);
}

function serviceIOUCanonical(iou: UnsignedServiceIOU): string {
  return JSON.stringify([
    'NERILO-SERVICE-IOU',
    SERVICE_IOU_VERSION,
    iou.iouId,
    iou.kind,
    iou.issuer.nodeId,
    iou.issuer.pubKey,
    iou.holder.nodeId,
    iou.holder.pubKey,
    iou.denomination.unit,
    iou.denomination.amount,
    iou.issuedAt,
    iou.expiresAt,
    iou.nonce,
  ]);
}

function endorsementCanonical(endorsement: UnsignedServiceEndorsement): string {
  return JSON.stringify([
    'NERILO-SERVICE-ENDORSEMENT',
    SERVICE_ENDORSEMENT_VERSION,
    endorsement.iouId,
    endorsement.seq,
    endorsement.from.nodeId,
    endorsement.from.pubKey,
    endorsement.toNodeId,
    endorsement.prevHash,
    endorsement.swapPairHash,
    endorsement.endorsedAt,
    endorsement.nonce,
  ]);
}

function signedCanonical(canonical: string, signature: string): string {
  return JSON.stringify([canonical, signature]);
}

export async function createServiceIOU(
  iou: UnsignedServiceIOU,
  sign: SignFn
): Promise<ServiceIOU> {
  return { ...iou, signature: await sign(serviceIOUCanonical(iou)) };
}

export async function createEndorsement(
  endorsement: UnsignedServiceEndorsement,
  sign: SignFn
): Promise<ServiceEndorsement> {
  return { ...endorsement, signature: await sign(endorsementCanonical(endorsement)) };
}

export async function iouHash(iou: ServiceIOU): Promise<string> {
  const { signature, ...unsigned } = iou;
  return sha256Hash(signedCanonical(serviceIOUCanonical(unsigned), signature));
}

export async function endorsementHash(endorsement: ServiceEndorsement): Promise<string> {
  const { signature, ...unsigned } = endorsement;
  return sha256Hash(signedCanonical(endorsementCanonical(unsigned), signature));
}

async function hasValidSignature(
  pubKey: string,
  canonical: string,
  signature: string
): Promise<boolean> {
  try {
    const verify = await ecdsaVerifier(pubKey);
    return await verify(canonical, signature);
  } catch {
    return false;
  }
}

export async function verifyServiceIOU(
  value: unknown,
  options: ServiceIOUVerifyOptions
): Promise<ServiceIOUValidation> {
  // Spec 031 §5.1 的順序是協議的一部分，請勿為了提早失敗而重排。
  if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' };
  if ((value as { v?: unknown }).v !== SERVICE_IOU_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!hasServiceIOUShape(value)) return { ok: false, reason: 'malformed' };
  const iou = value;
  if (!isKnownDenominationUnit(iou.denomination.unit)) {
    return { ok: false, reason: 'unknown-denomination' };
  }
  const [issuerMatches, holderMatches] = await Promise.all([
    pubKeyBindsNodeId(iou.issuer.nodeId, iou.issuer.pubKey),
    pubKeyBindsNodeId(iou.holder.nodeId, iou.holder.pubKey),
  ]);
  if (!issuerMatches || !holderMatches) return { ok: false, reason: 'identity-mismatch' };
  if (iou.expiresAt <= iou.issuedAt) return { ok: false, reason: 'malformed' };
  const { signature, ...unsigned } = iou;
  if (!(await hasValidSignature(iou.issuer.pubKey, serviceIOUCanonical(unsigned), signature))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (options.now > iou.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, holderNodeId: iou.holder.nodeId };
}

export async function verifyEndorsementChain(
  iouValue: unknown,
  chainValue: unknown,
  options: EndorsementChainVerifyOptions
): Promise<ServiceIOUValidation> {
  const iouValidation = await verifyServiceIOU(iouValue, options);
  if (!iouValidation.ok) return iouValidation;
  const iou = iouValue as ServiceIOU;
  if (iou.kind !== 'endorsable') return { ok: false, reason: 'not-endorsable' };
  if (!Array.isArray(chainValue)) return { ok: false, reason: 'malformed' };
  if (options.maxChainLength !== undefined
    && (!Number.isSafeInteger(options.maxChainLength)
      || options.maxChainLength < 0
      || chainValue.length > options.maxChainLength)) {
    return { ok: false, reason: 'malformed' };
  }

  for (const value of chainValue) {
    if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' };
    if ((value as { v?: unknown }).v !== SERVICE_ENDORSEMENT_VERSION) {
      return { ok: false, reason: 'unsupported-version' };
    }
    if (!hasEndorsementShape(value)) return { ok: false, reason: 'malformed' };
  }
  const chain = chainValue as ServiceEndorsement[];

  // Spec 031 §5.3 的九項鏈檢查維持分段，確保拒絕原因不受後續錯誤干擾。
  if (chain.some((endorsement, index) => endorsement.seq !== index + 1)) {
    return { ok: false, reason: 'chain-broken' };
  }
  if (chain.some((endorsement) => endorsement.iouId !== iou.iouId)) {
    return { ok: false, reason: 'chain-broken' };
  }

  let expectedHash = await iouHash(iou);
  for (const endorsement of chain) {
    if (endorsement.prevHash !== expectedHash) return { ok: false, reason: 'chain-broken' };
    expectedHash = await endorsementHash(endorsement);
  }

  let expectedFrom = iou.holder.nodeId;
  for (const endorsement of chain) {
    if (endorsement.from.nodeId !== expectedFrom) return { ok: false, reason: 'chain-broken' };
    expectedFrom = endorsement.toNodeId;
  }

  for (const endorsement of chain) {
    if (!(await pubKeyBindsNodeId(endorsement.from.nodeId, endorsement.from.pubKey))) {
      return { ok: false, reason: 'identity-mismatch' };
    }
  }

  for (const endorsement of chain) {
    const { signature, ...unsigned } = endorsement;
    if (!(await hasValidSignature(
      endorsement.from.pubKey,
      endorsementCanonical(unsigned),
      signature
    ))) {
      return { ok: false, reason: 'bad-signature' };
    }
  }

  for (const endorsement of chain) {
    if (endorsement.endorsedAt < iou.issuedAt
      || endorsement.endorsedAt > options.now + ENDORSEMENT_CLOCK_SKEW_MS) {
      return { ok: false, reason: 'malformed' };
    }
  }

  // 到期已由步驟 1 的 verifyServiceIOU 依 §5.1 檢查。
  return { ok: true, holderNodeId: expectedFrom };
}
