/**
 * Incentive System Types
 *
 * Defines the interface contract for relay incentive mechanisms.
 * Phase 1: Local credit system (IndexedDB-based)
 * Phase 2: Blockchain token migration (via IIncentiveProvider interface)
 */

import type { RelayReceipt, CreditBalance, ServiceTier } from '../relay/types';

/**
 * IIncentiveProvider — Abstract interface for relay incentive mechanism.
 *
 * This interface is the migration path from local credits to blockchain tokens.
 * Phase 1 uses LocalCreditProvider (IndexedDB).
 * Phase 2 will implement BlockchainCreditProvider (smart contract).
 */
export interface IIncentiveProvider {
  /**
   * Record a relay event and credit the relay node.
   *
   * @param relayNodeId Node that performed the relay
   * @param requesterNodeId Node that requested the relay
   * @param bytesRelayed Amount of data relayed
   * @param proof Cryptographic proof (signature from requester acknowledging relay)
   * @returns The relay receipt
   */
  recordRelay(
    relayNodeId: string,
    requesterNodeId: string,
    bytesRelayed: number,
    proof: string
  ): Promise<RelayReceipt>;

  /**
   * Get the credit balance for a node.
   */
  getBalance(nodeId: string): Promise<CreditBalance>;

  /**
   * Check if a node has sufficient credits to relay.
   */
  canRelay(nodeId: string): Promise<boolean>;

  /**
   * Settle accumulated credit receipts.
   * In Phase 1: updates local IndexedDB balances.
   * In Phase 2: submits transactions to blockchain.
   */
  settleCredits(receipts: RelayReceipt[]): Promise<void>;

  /**
   * Get the service tier for a node based on its balance.
   */
  getServiceTier(nodeId: string): Promise<ServiceTier>;

  /**
   * Deduct credits for sending a message via relay.
   *
   * @param nodeId The sending node
   * @param amount Credits to deduct
   * @returns Whether the deduction succeeded
   */
  deductCredits(nodeId: string, amount: number): Promise<boolean>;
}

/** Credit earning rates */
export interface CreditRates {
  /** Credits earned per KB relayed */
  perKbRelayed: number;
  /** Credits earned per successful relay (flat bonus) */
  perRelayBonus: number;
  /** Credits earned per hour of uptime as relay node */
  perUptimeHour: number;
}

/** Service tier thresholds */
export interface TierThresholds {
  /** Minimum balance for basic tier */
  basicMin: number;
  /** Minimum balance for premium tier */
  premiumMin: number;
}

/** Default credit rates */
export const DEFAULT_CREDIT_RATES: CreditRates = {
  perKbRelayed: 1,
  perRelayBonus: 5,
  perUptimeHour: 10,
};

/** Default tier thresholds */
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  basicMin: 0,
  premiumMin: 1000,
};
