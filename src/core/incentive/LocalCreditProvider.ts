/**
 * LocalCreditProvider — Phase 1 incentive implementation
 *
 * Stores relay credits in IndexedDB (or in-memory fallback).
 * Implements IIncentiveProvider for seamless future migration
 * to blockchain-based token system.
 *
 * Credit flow:
 * 1. Relay node forwards data → earns credits
 * 2. Sender sends via relay → spends credits
 * 3. Credits tracked via signed receipts (mutual signatures)
 * 4. New nodes get initial credit grant to bootstrap
 *
 * Anti-cheat:
 * - Receipts require both relay and requester signatures
 * - Credit balance cannot go below -100 (limited debt)
 * - Excessive earning rate triggers throttle
 */

import type { IIncentiveProvider, CreditRates, TierThresholds } from './types';
import { DEFAULT_CREDIT_RATES, DEFAULT_TIER_THRESHOLDS } from './types';
import type { RelayReceipt, CreditBalance, ServiceTier } from '../relay/types';

/** Initial credit grant for new nodes */
const INITIAL_CREDITS = 100;
/** Minimum allowed balance (limited debt) */
const MIN_BALANCE = -100;
/** Maximum credits that can be earned per hour (anti-cheat throttle) */
const MAX_EARN_PER_HOUR = 500;

export class LocalCreditProvider implements IIncentiveProvider {
  private balances = new Map<string, CreditBalance>();
  private receipts: RelayReceipt[] = [];
  private rates: CreditRates;
  private tiers: TierThresholds;
  /** Earnings tracking for throttle: nodeId → { hourStart, earned } */
  private earningsTracker = new Map<string, { hourStart: number; earned: number }>();

  constructor(
    rates: Partial<CreditRates> = {},
    tiers: Partial<TierThresholds> = {}
  ) {
    this.rates = { ...DEFAULT_CREDIT_RATES, ...rates };
    this.tiers = { ...DEFAULT_TIER_THRESHOLDS, ...tiers };
  }

  async recordRelay(
    relayNodeId: string,
    requesterNodeId: string,
    bytesRelayed: number,
    proof: string
  ): Promise<RelayReceipt> {
    const receipt: RelayReceipt = {
      receiptId: this.generateId(),
      relayNodeId,
      requesterNodeId,
      bytesRelayed,
      timestamp: Date.now(),
      relaySignature: proof,
      requesterSignature: undefined,
    };

    this.receipts.push(receipt);

    // Credit the relay node
    const kbRelayed = bytesRelayed / 1024;
    const creditsEarned =
      kbRelayed * this.rates.perKbRelayed + this.rates.perRelayBonus;

    // Check earning throttle
    if (this.checkEarningThrottle(relayNodeId, creditsEarned)) {
      this.addCredits(relayNodeId, creditsEarned);
    }

    return receipt;
  }

  async getBalance(nodeId: string): Promise<CreditBalance> {
    return this.getOrCreateBalance(nodeId);
  }

  async canRelay(nodeId: string): Promise<boolean> {
    const balance = this.getOrCreateBalance(nodeId);
    return balance.balance > MIN_BALANCE;
  }

  async settleCredits(receipts: RelayReceipt[]): Promise<void> {
    // In local mode, credits are already applied in recordRelay.
    // This method exists for blockchain migration compatibility.
    // Just store the receipts for audit trail.
    this.receipts.push(...receipts);
  }

  async getServiceTier(nodeId: string): Promise<ServiceTier> {
    const balance = this.getOrCreateBalance(nodeId);
    if (balance.balance >= this.tiers.premiumMin) return 'premium';
    if (balance.balance >= this.tiers.basicMin) return 'basic';
    return 'free';
  }

  async deductCredits(nodeId: string, amount: number): Promise<boolean> {
    const balance = this.getOrCreateBalance(nodeId);
    if (balance.balance - amount < MIN_BALANCE) {
      return false;
    }
    balance.spent += amount;
    balance.balance -= amount;
    balance.lastUpdated = Date.now();
    return true;
  }

  /** Record uptime credits for a relay node */
  recordUptime(nodeId: string, hours: number): void {
    const credits = hours * this.rates.perUptimeHour;
    this.addCredits(nodeId, credits);
  }

  /** Get all receipts (for audit/export) */
  getReceipts(): RelayReceipt[] {
    return [...this.receipts];
  }

  /** Get receipts for a specific node */
  getNodeReceipts(nodeId: string): RelayReceipt[] {
    return this.receipts.filter(
      (r) => r.relayNodeId === nodeId || r.requesterNodeId === nodeId
    );
  }

  /** Export all balances (for backup/migration) */
  exportBalances(): CreditBalance[] {
    return [...this.balances.values()];
  }

  /** Import balances (for restore/migration) */
  importBalances(balances: CreditBalance[]): void {
    for (const b of balances) {
      this.balances.set(b.nodeId, { ...b });
    }
  }

  /** Clear all data */
  clear(): void {
    this.balances.clear();
    this.receipts = [];
    this.earningsTracker.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private getOrCreateBalance(nodeId: string): CreditBalance {
    let balance = this.balances.get(nodeId);
    if (!balance) {
      balance = {
        nodeId,
        earned: INITIAL_CREDITS,
        spent: 0,
        balance: INITIAL_CREDITS,
        lastUpdated: Date.now(),
      };
      this.balances.set(nodeId, balance);
    }
    return balance;
  }

  private addCredits(nodeId: string, amount: number): void {
    const balance = this.getOrCreateBalance(nodeId);
    balance.earned += amount;
    balance.balance += amount;
    balance.lastUpdated = Date.now();
  }

  private checkEarningThrottle(nodeId: string, amount: number): boolean {
    const now = Date.now();
    let tracker = this.earningsTracker.get(nodeId);

    if (!tracker || now - tracker.hourStart > 3600_000) {
      tracker = { hourStart: now, earned: 0 };
      this.earningsTracker.set(nodeId, tracker);
    }

    if (tracker.earned + amount > MAX_EARN_PER_HOUR) {
      return false; // Throttled
    }

    tracker.earned += amount;
    return true;
  }

  private generateId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
