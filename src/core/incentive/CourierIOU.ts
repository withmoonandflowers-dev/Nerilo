/**
 * 信使欠條（Spec 001 實作期修訂，2026-07-16）。
 *
 * 點數不是 coin，也不是全域餘額。每張欠條都有明確發票人（issuer）、持有人
 * （holder）與面額。寄存者向信使開欠條；服務貢獻者取得受益人開的欠條。
 * 欠條交換需原發票人、目前持有人與新持有人同意；自己的欠條回到本人時，只有
 * 發票人本人簽署結清授權才註銷。每個信使只維護自己持有的債權，不需全域共識。
 */

import { generateUUID } from '../../utils/uuid';
import {
  cheapestQuote,
  nextCongestionPrice,
  storageCost,
  type CongestionPricingConfig,
  type CourierQuote,
  DEFAULT_CONGESTION_PRICING,
} from '../relay/CongestionPricing';
import {
  ecdsaVerifier,
  pubKeyBindsNodeId,
  verifyCoSignedReceipt,
} from '../relay/CourierReceipts';
import type { CoSignedRelayReceipt, SignFn } from './CoSignedReceipt';

export interface DepositQuote extends CourierQuote {
  quoteId: string;
  courierNodeId: string;
  issuerNodeId: string;
  bytes: number;
  durationMs: number;
  amount: number;
}

export interface DepositIOU {
  iouId: string;
  quoteId: string;
  issuerNodeId: string;
  holderNodeId: string;
  amount: number;
  issuedAt: number;
  nonce: string;
  issuerSig: string;
}

export interface ContributionTransferDraft {
  /** 原服務收據：requester 是欠條發票人，relay 是目前持有人。 */
  receipt: CoSignedRelayReceipt;
  issuerPubKey: string;
  holderPubKey: string;
  toHolderNodeId: string;
  amount: number;
  transferNonce: string;
  issuerSig: string;
  holderSig: string;
}

export interface RepaymentRequest {
  debtorNodeId: string;
  debtorPubKey: string;
  /** 要由發票人本人註銷的寄存欠條。 */
  depositIouIds: string[];
  /** 用來交換上述欠條的第三方服務欠條。 */
  transfer: ContributionTransferDraft;
  settlementSig: string;
}

export interface AcceptedContributionIOU extends ContributionTransferDraft {
  recipientSig: string;
  acceptedAt: number;
}

export interface CourierIOUBookConfig {
  /** 每個發票人可對本信使開出的未結欠條上限（冷啟動 epsilon）。 */
  creditLimitPerIssuer: number;
  quoteTtlMs: number;
  /** 同一信使最多多久調一次價；避免用 QUOTE 請求頻率操縱價格。 */
  pricingIntervalMs: number;
  storageDurationMs: number;
  initialStoragePrice: number;
  /** 服務貢獻收據每 byte 換算的欠條面額。 */
  contributionPricePerByte: number;
  pricing: CongestionPricingConfig;
}

export const DEFAULT_COURIER_IOU_CONFIG: CourierIOUBookConfig = {
  creditLimitPerIssuer: 0.01,
  quoteTtlMs: 30_000,
  pricingIntervalMs: 60_000,
  storageDurationMs: 14 * 86_400_000,
  initialStoragePrice: 0.000_001,
  contributionPricePerByte: 0.000_001,
  pricing: DEFAULT_CONGESTION_PRICING,
};

export type IOUAcceptResult =
  | { accepted: true; amount: number }
  | { accepted: false; reason: 'quote-not-found' | 'quote-expired' | 'quote-mismatch' | 'invalid-iou' | 'insufficient-credit' | 'duplicate-iou' };

export type IOURepayResult =
  | { accepted: true; settledAmount: number; recipientSig: string }
  | { accepted: false; reason: 'invalid-settlement' | 'invalid-transfer' | 'unknown-iou' | 'amount-too-low' | 'replayed-contribution' };

function depositCanonical(iou: Omit<DepositIOU, 'issuerSig'>): string {
  return JSON.stringify([
    iou.iouId,
    iou.quoteId,
    iou.issuerNodeId,
    iou.holderNodeId,
    iou.amount,
    iou.issuedAt,
    iou.nonce,
  ]);
}

function transferCanonical(t: Omit<ContributionTransferDraft, 'issuerSig' | 'holderSig'>): string {
  return JSON.stringify([
    t.receipt.nonce,
    t.receipt.requesterNodeId,
    t.receipt.relayNodeId,
    t.toHolderNodeId,
    t.amount,
    t.transferNonce,
  ]);
}

function settlementCanonical(req: Omit<RepaymentRequest, 'settlementSig'>): string {
  return JSON.stringify([
    req.debtorNodeId,
    [...req.depositIouIds].sort(),
    req.transfer.receipt.nonce,
    req.transfer.transferNonce,
    req.transfer.toHolderNodeId,
    req.transfer.amount,
  ]);
}

export async function createDepositIOU(
  quote: DepositQuote,
  now: number,
  issuerSign: SignFn,
  nonce = generateUUID()
): Promise<DepositIOU> {
  const unsigned: Omit<DepositIOU, 'issuerSig'> = {
    iouId: generateUUID(),
    quoteId: quote.quoteId,
    issuerNodeId: quote.issuerNodeId,
    holderNodeId: quote.courierNodeId,
    amount: quote.amount,
    issuedAt: now,
    nonce,
  };
  return { ...unsigned, issuerSig: await issuerSign(depositCanonical(unsigned)) };
}

export async function createContributionTransferDraft(
  receipt: CoSignedRelayReceipt,
  issuerPubKey: string,
  holderPubKey: string,
  toHolderNodeId: string,
  amount: number,
  issuerSign: SignFn,
  holderSign: SignFn,
  transferNonce = generateUUID()
): Promise<ContributionTransferDraft> {
  const unsigned = { receipt, issuerPubKey, holderPubKey, toHolderNodeId, amount, transferNonce };
  const canonical = transferCanonical(unsigned);
  const [issuerSig, holderSig] = await Promise.all([issuerSign(canonical), holderSign(canonical)]);
  return { ...unsigned, issuerSig, holderSig };
}

export async function createRepaymentRequest(
  debtorNodeId: string,
  debtorPubKey: string,
  depositIouIds: string[],
  transfer: ContributionTransferDraft,
  debtorSign: SignFn
): Promise<RepaymentRequest> {
  const unsigned = { debtorNodeId, debtorPubKey, depositIouIds, transfer };
  return { ...unsigned, settlementSig: await debtorSign(settlementCanonical(unsigned)) };
}

/** 一個信使持有的欠條簿。它不宣稱有全網餘額，只對自己接受的債權作權威判斷。 */
export class CourierIOUBook {
  private readonly quotes = new Map<string, DepositQuote>();
  private readonly claims = new Map<string, DepositIOU>();
  private readonly acceptedContributions = new Map<string, AcceptedContributionIOU>();
  private currentStoragePrice: number;
  private lastPriceUpdateAt: number | null = null;

  constructor(
    readonly ownerNodeId: string,
    private readonly ownerSign: SignFn,
    private readonly config: CourierIOUBookConfig = DEFAULT_COURIER_IOU_CONFIG,
    private readonly now: () => number = () => Date.now()
  ) {
    this.currentStoragePrice = config.initialStoragePrice;
  }

  issueQuote(issuerNodeId: string, bytes: number, utilization: number): DepositQuote {
    const now = this.now();
    if (this.lastPriceUpdateAt === null || now - this.lastPriceUpdateAt >= this.config.pricingIntervalMs) {
      this.currentStoragePrice = nextCongestionPrice(this.currentStoragePrice, utilization, this.config.pricing);
      this.lastPriceUpdateAt = now;
    }
    const quote: DepositQuote = {
      quoteId: generateUUID(),
      courierNodeId: this.ownerNodeId,
      issuerNodeId,
      bytes,
      durationMs: this.config.storageDurationMs,
      pricePerByteDay: this.currentStoragePrice,
      utilization,
      amount: storageCost(this.currentStoragePrice, bytes, this.config.storageDurationMs),
      expiresAt: now + this.config.quoteTtlMs,
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  quoteFor(iou: DepositIOU): DepositQuote | null {
    const quote = this.quotes.get(iou.quoteId);
    return quote && cheapestQuote([quote], this.now()) ? quote : null;
  }

  outstanding(issuerNodeId: string): number {
    let total = 0;
    for (const claim of this.claims.values()) {
      if (claim.issuerNodeId === issuerNodeId) total += claim.amount;
    }
    return total;
  }

  availableCredit(issuerNodeId: string): number {
    return Math.max(0, this.config.creditLimitPerIssuer - this.outstanding(issuerNodeId));
  }

  activeClaimIds(issuerNodeId: string): string[] {
    return [...this.claims.values()]
      .filter((claim) => claim.issuerNodeId === issuerNodeId)
      .map((claim) => claim.iouId);
  }

  async acceptDepositIOU(iou: DepositIOU, issuerPubKey: string): Promise<IOUAcceptResult> {
    if (this.claims.has(iou.iouId)) return { accepted: false, reason: 'duplicate-iou' };
    const quote = this.quotes.get(iou.quoteId);
    if (!quote) return { accepted: false, reason: 'quote-not-found' };
    if (quote.expiresAt < this.now()) return { accepted: false, reason: 'quote-expired' };
    if (
      iou.issuerNodeId !== quote.issuerNodeId ||
      iou.holderNodeId !== quote.courierNodeId ||
      iou.amount !== quote.amount
    ) return { accepted: false, reason: 'quote-mismatch' };
    if (!(await pubKeyBindsNodeId(iou.issuerNodeId, issuerPubKey))) {
      return { accepted: false, reason: 'invalid-iou' };
    }
    const verify = await ecdsaVerifier(issuerPubKey);
    const { issuerSig, ...unsigned } = iou;
    if (!(await verify(depositCanonical(unsigned), issuerSig))) {
      return { accepted: false, reason: 'invalid-iou' };
    }
    if (this.outstanding(iou.issuerNodeId) + iou.amount > this.config.creditLimitPerIssuer) {
      return { accepted: false, reason: 'insufficient-credit' };
    }
    this.claims.set(iou.iouId, iou);
    this.quotes.delete(iou.quoteId); // 單次報價，防重放
    return { accepted: true, amount: iou.amount };
  }

  /** store 在欠條接受後意外拒收時回滾，避免收債卻沒提供服務。 */
  rollbackDepositIOU(iouId: string): void {
    this.claims.delete(iouId);
  }

  /**
   * 接受第三方服務欠條，並把 debtor 自己開出的寄存欠條退回本人結清。
   * debtor 的 settlementSig 是「只有本人可結清」的執行證明；第三方欠條轉讓則需
   * 原發票人 + 目前持有人簽名，本信使最後加 recipientSig 表示同意交換。
   */
  async repay(req: RepaymentRequest): Promise<IOURepayResult> {
    if (!(await pubKeyBindsNodeId(req.debtorNodeId, req.debtorPubKey))) {
      return { accepted: false, reason: 'invalid-settlement' };
    }
    const debtorVerify = await ecdsaVerifier(req.debtorPubKey);
    const { settlementSig, ...unsignedRequest } = req;
    if (!(await debtorVerify(settlementCanonical(unsignedRequest), settlementSig))) {
      return { accepted: false, reason: 'invalid-settlement' };
    }

    const transfer = req.transfer;
    if (transfer.toHolderNodeId !== this.ownerNodeId || transfer.receipt.relayNodeId !== req.debtorNodeId) {
      return { accepted: false, reason: 'invalid-transfer' };
    }
    if (this.acceptedContributions.has(transfer.receipt.nonce)) {
      return { accepted: false, reason: 'replayed-contribution' };
    }
    if (!(await verifyCoSignedReceipt(transfer.receipt, transfer.holderPubKey, transfer.issuerPubKey))) {
      return { accepted: false, reason: 'invalid-transfer' };
    }
    const expectedAmount = Math.ceil(
      transfer.receipt.bytesRelayed * this.config.contributionPricePerByte * 1_000_000
    ) / 1_000_000;
    if (transfer.amount !== expectedAmount) return { accepted: false, reason: 'invalid-transfer' };
    const [issuerOk, holderOk] = await Promise.all([
      pubKeyBindsNodeId(transfer.receipt.requesterNodeId, transfer.issuerPubKey),
      pubKeyBindsNodeId(transfer.receipt.relayNodeId, transfer.holderPubKey),
    ]);
    if (!issuerOk || !holderOk) return { accepted: false, reason: 'invalid-transfer' };
    const [issuerVerify, holderVerify] = await Promise.all([
      ecdsaVerifier(transfer.issuerPubKey),
      ecdsaVerifier(transfer.holderPubKey),
    ]);
    const { issuerSig, holderSig, ...unsignedTransfer } = transfer;
    const transferText = transferCanonical(unsignedTransfer);
    const [issuerConsent, holderConsent] = await Promise.all([
      issuerVerify(transferText, issuerSig),
      holderVerify(transferText, holderSig),
    ]);
    if (!issuerConsent || !holderConsent) return { accepted: false, reason: 'invalid-transfer' };

    let settledAmount = 0;
    const claims: DepositIOU[] = [];
    for (const id of [...new Set(req.depositIouIds)]) {
      const claim = this.claims.get(id);
      if (!claim || claim.issuerNodeId !== req.debtorNodeId) {
        return { accepted: false, reason: 'unknown-iou' };
      }
      claims.push(claim);
      settledAmount += claim.amount;
    }
    if (transfer.amount < settledAmount) return { accepted: false, reason: 'amount-too-low' };

    const recipientSig = await this.ownerSign(transferText);
    for (const claim of claims) this.claims.delete(claim.iouId);
    this.acceptedContributions.set(transfer.receipt.nonce, {
      ...transfer,
      recipientSig,
      acceptedAt: this.now(),
    });
    return { accepted: true, settledAmount, recipientSig };
  }
}
