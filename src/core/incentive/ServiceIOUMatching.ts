/**
 * Protocol Spec 031 的交換意向、配對提議與條件背書成對驗證。
 *
 * SwapMatcher 的公開 API 只接觸意向與配對，刻意不接受 ServiceIOU 或
 * ServiceEndorsement。憑證與背書只會進入獨立的 verifySwapBundle 純函式。
 */
import { generateUUID } from '../../utils/uuid';
import { sha256Hash } from '../../utils/crypto';
import { ecdsaVerifier, pubKeyBindsNodeId } from '../relay/CourierReceipts';
import type { SignFn } from './CoSignedReceipt';
import {
  verifyEndorsementChain,
  type ServiceDenomination,
  type ServiceDenominationUnit,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOUParty,
  type ServiceIOURejectReason,
} from './ServiceIOU';

export interface SwapOffer {
  iouId: string;
  issuerNodeId: string;
  denomination: ServiceDenomination;
}

export interface SwapWant {
  unit: ServiceDenominationUnit;
  minAmount: number;
}

export interface UnsignedSwapIntent {
  v: 'nswapintent1';
  intentId: string;
  offer: SwapOffer;
  want: SwapWant;
  wantIssuers: string[] | null;
  holder: ServiceIOUParty;
  expiresAt: number;
  nonce: string;
}

export interface SwapIntent extends UnsignedSwapIntent {
  signature: string;
}

export interface UnsignedSwapPair {
  v: 'nswappair1';
  pairId: string;
  intentHashes: [string, string];
  matcher: ServiceIOUParty;
  proposedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface SwapPair extends UnsignedSwapPair {
  signature: string;
}

export interface SwapEndorsementLeg {
  iou: ServiceIOU;
  chain: ServiceEndorsement[];
}

export type SwapValidation =
  | { ok: true }
  | { ok: false; reason: ServiceIOURejectReason };

export interface SwapBundleVerifyOptions {
  now: number;
  maxChainLength?: number;
}

export interface ProposedSwapMatch {
  pair: SwapPair;
  intents: [SwapIntent, SwapIntent];
}

const SWAP_INTENT_VERSION = 'nswapintent1';
const SWAP_PAIR_VERSION = 'nswappair1';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
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

function isKnownUnit(value: unknown): value is ServiceDenominationUnit {
  return value === 'relay-bytes' || value === 'custody-byte-days' || value === 'priority';
}

function isParty(value: unknown): value is ServiceIOUParty {
  if (!value || typeof value !== 'object') return false;
  const party = value as Partial<ServiceIOUParty>;
  return isNonEmptyString(party.nodeId) && isNonEmptyString(party.pubKey);
}

function hasIntentShape(value: unknown): value is SwapIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<SwapIntent>;
  const offer = intent.offer as Partial<SwapOffer> | undefined;
  const denomination = offer?.denomination as Partial<ServiceDenomination> | undefined;
  const want = intent.want as Partial<SwapWant> | undefined;
  return intent.v === SWAP_INTENT_VERSION
    && isNonEmptyString(intent.intentId)
    && !!offer
    && isNonEmptyString(offer.iouId)
    && isNonEmptyString(offer.issuerNodeId)
    && !!denomination
    && isNonEmptyString(denomination.unit)
    && typeof denomination.amount === 'number'
    && Number.isSafeInteger(denomination.amount)
    && denomination.amount >= 0
    && !!want
    && isNonEmptyString(want.unit)
    && typeof want.minAmount === 'number'
    && Number.isSafeInteger(want.minAmount)
    && want.minAmount >= 0
    && (intent.wantIssuers === null
      || (Array.isArray(intent.wantIssuers) && intent.wantIssuers.every(isNonEmptyString)))
    && isParty(intent.holder)
    && typeof intent.expiresAt === 'number'
    && Number.isSafeInteger(intent.expiresAt)
    && isNonce(intent.nonce)
    && isNonEmptyString(intent.signature);
}

function hasPairShape(value: unknown): value is SwapPair {
  if (!value || typeof value !== 'object') return false;
  const pair = value as Partial<SwapPair>;
  return pair.v === SWAP_PAIR_VERSION
    && isNonEmptyString(pair.pairId)
    && Array.isArray(pair.intentHashes)
    && pair.intentHashes.length === 2
    && pair.intentHashes.every(isHash)
    && isParty(pair.matcher)
    && typeof pair.proposedAt === 'number'
    && Number.isSafeInteger(pair.proposedAt)
    && typeof pair.expiresAt === 'number'
    && Number.isSafeInteger(pair.expiresAt)
    && isNonce(pair.nonce)
    && isNonEmptyString(pair.signature);
}

function intentCanonical(intent: UnsignedSwapIntent): string {
  return JSON.stringify([
    'NERILO-SWAP-INTENT',
    SWAP_INTENT_VERSION,
    intent.intentId,
    intent.offer.iouId,
    intent.offer.issuerNodeId,
    intent.offer.denomination.unit,
    intent.offer.denomination.amount,
    intent.want.unit,
    intent.want.minAmount,
    intent.wantIssuers,
    intent.holder.nodeId,
    intent.holder.pubKey,
    intent.expiresAt,
    intent.nonce,
  ]);
}

function pairCanonical(pair: UnsignedSwapPair): string {
  return JSON.stringify([
    'NERILO-SWAP-PAIR',
    SWAP_PAIR_VERSION,
    pair.pairId,
    pair.intentHashes,
    pair.matcher.nodeId,
    pair.matcher.pubKey,
    pair.proposedAt,
    pair.expiresAt,
    pair.nonce,
  ]);
}

function signedCanonical(canonical: string, signature: string): string {
  return JSON.stringify([canonical, signature]);
}

function sortedHashes(hashes: readonly string[]): [string, string] {
  if (hashes.length !== 2) throw new RangeError('swap pair requires exactly two intent hashes');
  return [...hashes].sort() as [string, string];
}

function isSortedHashes(hashes: readonly string[]): boolean {
  return hashes.length === 2 && hashes[0] <= hashes[1];
}

export async function createSwapIntent(
  intent: UnsignedSwapIntent,
  holderSign: SignFn
): Promise<SwapIntent> {
  return { ...intent, signature: await holderSign(intentCanonical(intent)) };
}

export async function verifySwapIntent(intentValue: unknown, options: { now: number }): Promise<SwapValidation> {
  if (!intentValue || typeof intentValue !== 'object') return { ok: false, reason: 'malformed' };
  if ((intentValue as { v?: unknown }).v !== SWAP_INTENT_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!hasIntentShape(intentValue)) return { ok: false, reason: 'malformed' };
  const intent = intentValue;
  if (!isKnownUnit(intent.offer.denomination.unit) || !isKnownUnit(intent.want.unit)) {
    return { ok: false, reason: 'unknown-denomination' };
  }
  if (intent.expiresAt < options.now) return { ok: false, reason: 'expired' };
  try {
    if (!(await pubKeyBindsNodeId(intent.holder.nodeId, intent.holder.pubKey))) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    const verify = await ecdsaVerifier(intent.holder.pubKey);
    const { signature, ...unsigned } = intent;
    return await verify(intentCanonical(unsigned), signature)
      ? { ok: true }
      : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}

export async function swapIntentHash(intent: SwapIntent): Promise<string> {
  const { signature, ...unsigned } = intent;
  return sha256Hash(signedCanonical(intentCanonical(unsigned), signature));
}

export async function createSwapPair(
  pair: Omit<UnsignedSwapPair, 'intentHashes'> & { intentHashes: readonly string[] },
  matcherSign: SignFn
): Promise<SwapPair> {
  const unsigned: UnsignedSwapPair = { ...pair, intentHashes: sortedHashes(pair.intentHashes) };
  return { ...unsigned, signature: await matcherSign(pairCanonical(unsigned)) };
}

export async function verifySwapPair(
  pairValue: unknown,
  options: { now: number }
): Promise<SwapValidation> {
  if (!pairValue || typeof pairValue !== 'object') return { ok: false, reason: 'malformed' };
  if ((pairValue as { v?: unknown }).v !== SWAP_PAIR_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!hasPairShape(pairValue)) return { ok: false, reason: 'malformed' };
  const pair = pairValue;
  if (!isSortedHashes(pair.intentHashes) || pair.expiresAt <= pair.proposedAt) {
    return { ok: false, reason: 'malformed' };
  }
  if (pair.expiresAt < options.now) return { ok: false, reason: 'expired' };
  try {
    if (!(await pubKeyBindsNodeId(pair.matcher.nodeId, pair.matcher.pubKey))) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    const verify = await ecdsaVerifier(pair.matcher.pubKey);
    const { signature, ...unsigned } = pair;
    return await verify(pairCanonical(unsigned), signature)
      ? { ok: true }
      : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}

export async function swapPairHash(pair: SwapPair): Promise<string> {
  const { signature, ...unsigned } = pair;
  return sha256Hash(signedCanonical(pairCanonical(unsigned), signature));
}

function sameHashes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function offerMatchesIOU(intent: SwapIntent, iou: ServiceIOU): boolean {
  return intent.offer.iouId === iou.iouId
    && intent.offer.issuerNodeId === iou.issuer.nodeId
    && intent.offer.denomination.unit === iou.denomination.unit
    && intent.offer.denomination.amount === iou.denomination.amount;
}

export async function verifySwapBundle(
  pair: SwapPair,
  intents: readonly SwapIntent[],
  endorsements: readonly SwapEndorsementLeg[],
  options: SwapBundleVerifyOptions
): Promise<SwapValidation> {
  // 本函式刻意無狀態：重複驗證只會得到相同結果。防止同一配對產生第二次
  // 轉移是 D4 開票人登記簿的責任，不在這裡假裝已處理重放。
  // Spec 031 §6.2：逾時必須優先於所有其他拒絕原因。
  if (options.now > pair.expiresAt) return { ok: false, reason: 'swap-expired' };

  const pairValidation = await verifySwapPair(pair, { now: options.now });
  if (!pairValidation.ok) return pairValidation;
  if (intents.length !== 2) return { ok: false, reason: 'malformed' };
  for (const intent of intents) {
    const intentValidation = await verifySwapIntent(intent, { now: options.now });
    if (!intentValidation.ok) return intentValidation;
  }
  const actualIntentHashes = sortedHashes(await Promise.all(intents.map((intent) => swapIntentHash(intent))));
  if (!sameHashes(pair.intentHashes, actualIntentHashes)) return { ok: false, reason: 'malformed' };
  if (endorsements.length !== 2) return { ok: false, reason: 'swap-incomplete' };

  const pairHash = await swapPairHash(pair);
  const finalEndorsements = endorsements.map((leg) => leg.chain[leg.chain.length - 1]);
  if (finalEndorsements.some((endorsement) => endorsement?.swapPairHash !== pairHash)) {
    return { ok: false, reason: 'swap-incomplete' };
  }

  const byHolder = new Map(intents.map((intent) => [intent.holder.nodeId, intent]));
  for (const leg of endorsements) {
    const finalEndorsement = leg.chain[leg.chain.length - 1]!;
    const ownIntent = byHolder.get(finalEndorsement.from.nodeId);
    const otherIntent = intents.find((intent) => intent.holder.nodeId !== finalEndorsement.from.nodeId);
    if (!ownIntent
      || !otherIntent
      || finalEndorsement.toNodeId !== otherIntent.holder.nodeId
      || !offerMatchesIOU(ownIntent, leg.iou)) {
      return { ok: false, reason: 'chain-broken' };
    }
  }
  if (new Set(finalEndorsements.map((endorsement) => endorsement!.from.nodeId)).size !== 2) {
    return { ok: false, reason: 'chain-broken' };
  }

  for (const leg of endorsements) {
    const validation = await verifyEndorsementChain(leg.iou, leg.chain, {
      now: options.now,
      maxChainLength: options.maxChainLength,
    });
    if (!validation.ok) return { ok: false, reason: validation.reason };
  }
  return { ok: true };
}

function intentsAreCompatible(a: SwapIntent, b: SwapIntent): boolean {
  if (a.holder.nodeId === b.holder.nodeId) return false;
  const aSatisfiesB = a.offer.denomination.unit === b.want.unit
    && a.offer.denomination.amount >= b.want.minAmount
    && (b.wantIssuers === null || b.wantIssuers.includes(a.offer.issuerNodeId));
  const bSatisfiesA = b.offer.denomination.unit === a.want.unit
    && b.offer.denomination.amount >= a.want.minAmount
    && (a.wantIssuers === null || a.wantIssuers.includes(b.offer.issuerNodeId));
  return aSatisfiesB && bSatisfiesA;
}

/**
 * 撮合者只保存可驗證報價，不接受也不保存憑證或背書。
 * 這個 API 邊界是「撮合節點拿不到憑證」的結構性保證。
 */
export class SwapMatcher {
  private readonly intents = new Map<string, SwapIntent>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async addIntent(intent: SwapIntent): Promise<boolean> {
    this.pruneExpired();
    const validation = await verifySwapIntent(intent, { now: this.now() });
    if (!validation.ok) return false;
    this.intents.set(intent.intentId, intent);
    return true;
  }

  pendingIntents(): SwapIntent[] {
    this.pruneExpired();
    return [...this.intents.values()];
  }

  async proposeMatch(
    matcher: ServiceIOUParty,
    matcherSign: SignFn,
    expiresAt: number
  ): Promise<ProposedSwapMatch | null> {
    this.pruneExpired();
    const pending = [...this.intents.values()];
    for (let left = 0; left < pending.length; left++) {
      for (let right = left + 1; right < pending.length; right++) {
        const a = pending[left];
        const b = pending[right];
        if (!intentsAreCompatible(a, b)) continue;
        const proposedAt = this.now();
        const pairExpiresAt = Math.min(expiresAt, a.expiresAt, b.expiresAt);
        if (pairExpiresAt <= proposedAt) continue;
        const pair = await createSwapPair({
          v: SWAP_PAIR_VERSION,
          pairId: generateUUID(),
          intentHashes: await Promise.all([swapIntentHash(a), swapIntentHash(b)]),
          matcher,
          proposedAt,
          expiresAt: pairExpiresAt,
          nonce: generateUUID(),
        }, matcherSign);
        this.intents.delete(a.intentId);
        this.intents.delete(b.intentId);
        return { pair, intents: [a, b] };
      }
    }
    return null;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [intentId, intent] of this.intents) {
      if (intent.expiresAt < now) this.intents.delete(intentId);
    }
  }
}
