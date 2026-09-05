/**
 * Protocol Spec 031 的服務債權兌換請求與開票人餘額簿。
 *
 * 本檔驗證 nsredeem1、扣減開票人本機餘額，並以注入介面把寄存面額交給
 * CourierIOUBook。網路傳輸與 UI 不屬於本模組。
 */
import { generateUUID } from '../../utils/uuid';
import { sha256Hash } from '../../utils/crypto';
import { ecdsaVerifier, pubKeyBindsNodeId } from '../relay/CourierReceipts';
import type { SignFn } from './CoSignedReceipt';
import {
  endorsementHash,
  iouHash,
  verifyEndorsementChain,
  verifyServiceIOU,
  type ServiceDenomination,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOUParty,
  type ServiceIOURejectReason,
  type ServiceIOUValidation,
} from './ServiceIOU';

export interface UnsignedServiceRedeemRequest {
  v: 'nsredeem1';
  iou: ServiceIOU;
  chain: ServiceEndorsement[];
  claimant: ServiceIOUParty;
  requested: ServiceDenomination;
  requestedAt: number;
  nonce: string;
}

export interface ServiceRedeemRequest extends UnsignedServiceRedeemRequest {
  signature: string;
}

export interface IssuerRedemptionRecord {
  iouId: string;
  iouHash: string;
  denomination: ServiceDenomination;
  remaining: number;
  redeemedNonces: string[];
}

export interface IssuerRedemptionSnapshot {
  version: 1;
  issuerNodeId: string;
  records: IssuerRedemptionRecord[];
}

export interface IssuerRedemptionPersistence {
  load(issuerNodeId: string): Promise<IssuerRedemptionSnapshot | null>;
  save(snapshot: IssuerRedemptionSnapshot): Promise<void>;
}

export interface CustodyQuotaGranter {
  grantCustodyQuota(issuerNodeId: string, byteDays: number): number;
}

export type ServiceRedeemResult =
  | { accepted: true; granted: number; remaining: number }
  | { accepted: false; reason: ServiceIOURejectReason };

const SERVICE_REDEEM_VERSION = 'nsredeem1';

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

function hasRedeemRequestShape(value: unknown): value is ServiceRedeemRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<ServiceRedeemRequest>;
  const requested = request.requested as Partial<ServiceDenomination> | undefined;
  return request.v === SERVICE_REDEEM_VERSION
    && !!request.iou
    && typeof request.iou === 'object'
    && Array.isArray(request.chain)
    && isParty(request.claimant)
    && !!requested
    && isNonEmptyString(requested.unit)
    && typeof requested.amount === 'number'
    && Number.isSafeInteger(requested.amount)
    && typeof request.requestedAt === 'number'
    && Number.isSafeInteger(request.requestedAt)
    && isNonce(request.nonce)
    && isNonEmptyString(request.signature);
}

export async function serviceEndorsementChainHash(
  chain: readonly ServiceEndorsement[]
): Promise<string> {
  const hashes = await Promise.all(chain.map((endorsement) => endorsementHash(endorsement)));
  return sha256Hash(JSON.stringify(hashes));
}

async function redeemCanonical(request: UnsignedServiceRedeemRequest): Promise<string> {
  return JSON.stringify([
    'NERILO-SERVICE-REDEEM',
    SERVICE_REDEEM_VERSION,
    await iouHash(request.iou),
    await serviceEndorsementChainHash(request.chain),
    request.claimant.nodeId,
    request.claimant.pubKey,
    request.requested.unit,
    request.requested.amount,
    request.requestedAt,
    request.nonce,
  ]);
}

export async function createRedeemRequest(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  claimant: ServiceIOUParty,
  requested: ServiceDenomination,
  requestedAt: number,
  claimantSign: SignFn,
  nonce = generateUUID()
): Promise<ServiceRedeemRequest> {
  const unsigned: UnsignedServiceRedeemRequest = {
    v: SERVICE_REDEEM_VERSION,
    iou,
    chain: [...chain],
    claimant,
    requested,
    requestedAt,
    nonce,
  };
  return { ...unsigned, signature: await claimantSign(await redeemCanonical(unsigned)) };
}

async function sameIOUAndChain(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  request: ServiceRedeemRequest
): Promise<boolean> {
  try {
    const [expectedIOU, requestIOU, expectedChain, requestChain] = await Promise.all([
      iouHash(iou),
      iouHash(request.iou),
      serviceEndorsementChainHash(chain),
      serviceEndorsementChainHash(request.chain),
    ]);
    return expectedIOU === requestIOU && expectedChain === requestChain;
  } catch {
    return false;
  }
}

export async function verifyRedeemRequest(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  value: unknown,
  options: { now: number; maxChainLength?: number }
): Promise<ServiceIOUValidation> {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'malformed' };
  if ((value as { v?: unknown }).v !== SERVICE_REDEEM_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!hasRedeemRequestShape(value)) return { ok: false, reason: 'malformed' };
  const request = value;

  let holderValidation: ServiceIOUValidation;
  if (iou.kind === 'registered') {
    if (chain.length !== 0 || request.chain.length !== 0) return { ok: false, reason: 'malformed' };
    holderValidation = await verifyServiceIOU(iou, options);
  } else {
    holderValidation = await verifyEndorsementChain(iou, chain, options);
  }
  if (!holderValidation.ok) return holderValidation;
  if (!(await sameIOUAndChain(iou, chain, request))) return { ok: false, reason: 'chain-broken' };
  if (request.claimant.nodeId !== holderValidation.holderNodeId) {
    return { ok: false, reason: 'chain-broken' };
  }
  if (request.requested.unit !== iou.denomination.unit
    || !Number.isSafeInteger(request.requested.amount)
    || request.requested.amount <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  try {
    if (!(await pubKeyBindsNodeId(request.claimant.nodeId, request.claimant.pubKey))) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    const verify = await ecdsaVerifier(request.claimant.pubKey);
    const { signature, ...unsigned } = request;
    if (!(await verify(await redeemCanonical(unsigned), signature))) {
      return { ok: false, reason: 'bad-signature' };
    }
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, holderNodeId: holderValidation.holderNodeId };
}

/** 開票人只對自己開出的憑證維護餘額；預設純記憶體，可選擇注入耐久層。 */
export class IssuerRedemptionBook {
  private readonly records = new Map<string, IssuerRedemptionRecord>();
  private revision = 0;
  private persistedRevision = 0;
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(
    readonly issuerNodeId: string,
    private readonly persistence?: IssuerRedemptionPersistence,
    private readonly custodyQuotaGranter?: CustodyQuotaGranter
  ) {}

  remaining(iouId: string): number | null {
    return this.records.get(iouId)?.remaining ?? null;
  }

  async redeem(
    iou: ServiceIOU,
    chain: readonly ServiceEndorsement[],
    request: ServiceRedeemRequest,
    options: { now: number; maxChainLength?: number }
  ): Promise<ServiceRedeemResult> {
    const existingRecord = this.records.get(iou.iouId);
    if (!existingRecord && iou.issuer.nodeId !== this.issuerNodeId) {
      return { accepted: false, reason: 'unknown-iou' };
    }
    const validation = await verifyRedeemRequest(iou, chain, request, options);
    if (!validation.ok) return { accepted: false, reason: validation.reason };

    const fingerprint = await iouHash(iou);
    if (existingRecord && existingRecord.iouHash !== fingerprint) {
      return { accepted: false, reason: 'unknown-iou' };
    }
    const record = existingRecord ?? {
      iouId: iou.iouId,
      iouHash: fingerprint,
      denomination: { ...iou.denomination },
      remaining: iou.denomination.amount,
      redeemedNonces: [],
    };
    if (record.redeemedNonces.includes(request.nonce)) {
      return { accepted: false, reason: 'malformed' };
    }
    if (request.requested.amount > record.remaining) {
      return { accepted: false, reason: 'insufficient-balance' };
    }

    record.remaining -= request.requested.amount;
    record.redeemedNonces.push(request.nonce);
    if (!existingRecord) this.records.set(iou.iouId, record);
    this.revision++;
    if (request.requested.unit === 'custody-byte-days') {
      this.custodyQuotaGranter?.grantCustodyQuota(
        validation.holderNodeId,
        request.requested.amount
      );
    }
    return {
      accepted: true,
      granted: request.requested.amount,
      remaining: record.remaining,
    };
  }

  private snapshot(): IssuerRedemptionSnapshot {
    return {
      version: 1,
      issuerNodeId: this.issuerNodeId,
      records: [...this.records.values()].map((record) => ({
        ...record,
        denomination: { ...record.denomination },
        redeemedNonces: [...record.redeemedNonces],
      })),
    };
  }

  async flush(): Promise<boolean> {
    if (!this.persistence || this.persistedRevision >= this.revision) return true;
    const targetRevision = this.revision;
    let ok = true;
    this.persistenceTail = this.persistenceTail.then(async () => {
      if (this.persistedRevision >= targetRevision) return;
      try {
        const savedRevision = this.revision;
        await this.persistence!.save(this.snapshot());
        this.persistedRevision = savedRevision;
      } catch {
        ok = false;
      }
    });
    await this.persistenceTail;
    return ok && this.persistedRevision >= targetRevision;
  }

  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    let snapshot: IssuerRedemptionSnapshot | null;
    try {
      snapshot = await this.persistence.load(this.issuerNodeId);
    } catch {
      return;
    }
    if (!snapshot
      || snapshot.version !== 1
      || snapshot.issuerNodeId !== this.issuerNodeId
      || !Array.isArray(snapshot.records)) return;

    this.records.clear();
    for (const record of snapshot.records) {
      if (!record
        || !isNonEmptyString(record.iouId)
        || !isNonEmptyString(record.iouHash)
        || !record.denomination
        || !isNonEmptyString(record.denomination.unit)
        || !Number.isSafeInteger(record.denomination.amount)
        || record.denomination.amount < 0
        || !Number.isSafeInteger(record.remaining)
        || record.remaining < 0
        || record.remaining > record.denomination.amount
        || !Array.isArray(record.redeemedNonces)
        || record.redeemedNonces.some((nonce) => !isNonce(nonce))) continue;
      this.records.set(record.iouId, {
        ...record,
        denomination: { ...record.denomination },
        redeemedNonces: [...new Set(record.redeemedNonces)],
      });
    }
    this.revision = 1;
    this.persistedRevision = 0;
    await this.flush();
  }
}
