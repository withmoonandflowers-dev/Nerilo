/**
 * PeerScoring — GossipSub v1.1 inspired multi-dimensional peer scoring
 *
 * Scores peers based on observed behavior to defend against:
 * - Sybil attacks (IP colocation detection)
 * - Eclipse attacks (diverse peer selection)
 * - Spam/flooding (invalid message tracking)
 * - Free-riding (delivery rate monitoring)
 *
 * Score range: -100 (malicious) to +100 (excellent)
 */

import type { PeerBehaviorScore, ScoringThresholds } from './types';

/** Scoring weight configuration */
interface ScoringWeights {
  /** Weight for message delivery rate (0-1) */
  deliveryRate: number;
  /** Weight for mesh presence duration (0-1) */
  meshPresence: number;
  /** Penalty weight for invalid messages */
  invalidPenalty: number;
  /** Penalty weight for excessive duplicates */
  duplicatePenalty: number;
  /** Weight for first-arrival rate */
  firstArrival: number;
  /** Penalty for IP colocation */
  colocationPenalty: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  deliveryRate: 0.30,
  meshPresence: 0.15,
  invalidPenalty: 0.20,
  duplicatePenalty: 0.10,
  firstArrival: 0.15,
  colocationPenalty: 0.10,
};

const DEFAULT_THRESHOLDS: ScoringThresholds = {
  gossipThreshold: -10,
  graylistThreshold: -40,
  disconnectThreshold: -70,
  relayEligibleThreshold: 30,
};

/** Decay interval: scores decay toward 0 every this many ms */
const DECAY_INTERVAL_MS = 60_000; // 1 minute
/** Decay factor per interval (0-1, closer to 1 = slower decay) */
const DECAY_FACTOR = 0.95;


export class PeerScoring {
  private scores = new Map<string, PeerBehaviorScore>();
  private ipCounts = new Map<string, number>();
  private weights: ScoringWeights;
  private thresholds: ScoringThresholds;
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    weights: Partial<ScoringWeights> = {},
    thresholds: Partial<ScoringThresholds> = {}
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** Start periodic score decay */
  start(): void {
    if (this.decayTimer) return;
    this.decayTimer = setInterval(() => this.decayAll(), DECAY_INTERVAL_MS);
  }

  /** Stop periodic decay */
  stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
  }

  /** Register a new peer */
  addPeer(nodeId: string, ipHash?: string): void {
    if (this.scores.has(nodeId)) return;

    const score: PeerBehaviorScore = {
      nodeId,
      deliveryRate: 0.5, // neutral starting point
      invalidMessageCount: 0,
      duplicatesSent: 0,
      meshPresenceMs: 0,
      firstArrivalRate: 0,
      ipHash,
      compositeScore: 0,
      lastUpdated: Date.now(),
    };

    this.scores.set(nodeId, score);
    this.recompute(score);

    if (ipHash) {
      this.ipCounts.set(ipHash, (this.ipCounts.get(ipHash) ?? 0) + 1);
    }
  }

  /** Remove a peer */
  removePeer(nodeId: string): void {
    const score = this.scores.get(nodeId);
    if (!score) return;

    if (score.ipHash) {
      const count = this.ipCounts.get(score.ipHash) ?? 1;
      if (count <= 1) {
        this.ipCounts.delete(score.ipHash);
      } else {
        this.ipCounts.set(score.ipHash, count - 1);
      }
    }

    this.scores.delete(nodeId);
  }

  /** Record a successful message delivery from this peer */
  recordDelivery(nodeId: string): void {
    const s = this.scores.get(nodeId);
    if (!s) return;
    // Exponential moving average
    s.deliveryRate = s.deliveryRate * 0.9 + 0.1;
    s.lastUpdated = Date.now();
    this.recompute(s);
  }

  /** Record a failed delivery attempt */
  recordDeliveryFailure(nodeId: string): void {
    const s = this.scores.get(nodeId);
    if (!s) return;
    s.deliveryRate = s.deliveryRate * 0.9;
    s.lastUpdated = Date.now();
    this.recompute(s);
  }

  /** Record an invalid message from this peer */
  recordInvalidMessage(nodeId: string): void {
    const s = this.scores.get(nodeId);
    if (!s) return;
    s.invalidMessageCount++;
    s.lastUpdated = Date.now();
    this.recompute(s);
  }

  /** Record a duplicate message from this peer */
  recordDuplicate(nodeId: string): void {
    const s = this.scores.get(nodeId);
    if (!s) return;
    s.duplicatesSent++;
    s.lastUpdated = Date.now();
    this.recompute(s);
  }

  /** Record that this peer's path delivered first */
  recordFirstArrival(nodeId: string): void {
    const s = this.scores.get(nodeId);
    if (!s) return;
    s.firstArrivalRate = s.firstArrivalRate * 0.9 + 0.1;
    s.lastUpdated = Date.now();
    this.recompute(s);
  }

  /** Update mesh presence duration */
  recordMeshPresence(nodeId: string, durationMs: number): void {
    const s = this.scores.get(nodeId);
    if (!s) return;
    s.meshPresenceMs = durationMs;
    s.lastUpdated = Date.now();
    this.recompute(s);
  }

  /** Get the composite score for a peer */
  getScore(nodeId: string): number {
    return this.scores.get(nodeId)?.compositeScore ?? 0;
  }

  /** Get full behavior score for a peer */
  getPeerScore(nodeId: string): PeerBehaviorScore | undefined {
    return this.scores.get(nodeId);
  }

  /** Check if a peer is graylisted (should not process messages from) */
  isGraylisted(nodeId: string): boolean {
    const score = this.getScore(nodeId);
    return score < this.thresholds.graylistThreshold;
  }

  /** Check if a peer should be disconnected */
  shouldDisconnect(nodeId: string): boolean {
    const score = this.getScore(nodeId);
    return score < this.thresholds.disconnectThreshold;
  }

  /** Check if gossip should be suppressed for this peer */
  isGossipSuppressed(nodeId: string): boolean {
    const score = this.getScore(nodeId);
    return score < this.thresholds.gossipThreshold;
  }

  /** Check if a peer is eligible for relay duties */
  isRelayEligible(nodeId: string): boolean {
    const score = this.getScore(nodeId);
    return score >= this.thresholds.relayEligibleThreshold;
  }

  /** Get all peers sorted by score (highest first) */
  getRankedPeers(): PeerBehaviorScore[] {
    return [...this.scores.values()].sort(
      (a, b) => b.compositeScore - a.compositeScore
    );
  }

  /** Get peers eligible for relay */
  getRelayEligiblePeers(): PeerBehaviorScore[] {
    return this.getRankedPeers().filter(
      (s) => s.compositeScore >= this.thresholds.relayEligibleThreshold
    );
  }

  /** Get the number of peers sharing the same IP hash */
  getColocationCount(nodeId: string): number {
    const s = this.scores.get(nodeId);
    if (!s?.ipHash) return 1;
    return this.ipCounts.get(s.ipHash) ?? 1;
  }

  /** Get current thresholds */
  getThresholds(): ScoringThresholds {
    return { ...this.thresholds };
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.scores.clear();
    this.ipCounts.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Recompute composite score for a peer */
  private recompute(s: PeerBehaviorScore): void {
    const w = this.weights;

    // Positive factors (0-1 normalized, then scaled to 0-100)
    const deliveryScore = s.deliveryRate * 100;
    const presenceScore = Math.min(s.meshPresenceMs / (3600_000), 1) * 100; // max at 1 hour
    const firstArrivalScore = s.firstArrivalRate * 100;

    // Negative factors (penalties)
    const invalidPenalty = Math.min(s.invalidMessageCount * 15, 500);
    const dupPenalty = Math.min(s.duplicatesSent * 5, 200);

    // IP colocation penalty
    const colocationCount = s.ipHash ? (this.ipCounts.get(s.ipHash) ?? 1) : 1;
    const colocationPenalty = colocationCount > 1
      ? Math.min((colocationCount - 1) * 15, 50)
      : 0;

    // Weighted composite
    const positive =
      deliveryScore * w.deliveryRate +
      presenceScore * w.meshPresence +
      firstArrivalScore * w.firstArrival;

    const negative =
      invalidPenalty * w.invalidPenalty +
      dupPenalty * w.duplicatePenalty +
      colocationPenalty * w.colocationPenalty;

    s.compositeScore = Math.max(-100, Math.min(100, positive - negative));
  }

  /** Decay all scores toward neutral */
  private decayAll(): void {
    const now = Date.now();
    for (const s of this.scores.values()) {
      // Decay negative counters
      s.invalidMessageCount = Math.floor(s.invalidMessageCount * DECAY_FACTOR);
      s.duplicatesSent = Math.floor(s.duplicatesSent * DECAY_FACTOR);

      // Delivery rate decays toward 0.5 (neutral)
      s.deliveryRate = s.deliveryRate * DECAY_FACTOR + 0.5 * (1 - DECAY_FACTOR);

      // First arrival rate decays toward 0
      s.firstArrivalRate *= DECAY_FACTOR;

      s.lastUpdated = now;
      this.recompute(s);
    }
  }
}
