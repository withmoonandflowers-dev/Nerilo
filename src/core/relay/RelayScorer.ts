/**
 * RelayScorer — Composite scoring for relay node quality
 *
 * Integrates data from HeartbeatService, MetricsCollector,
 * and SuperNodeElection to produce a unified relay quality score.
 *
 * Score formula:
 *   0.35 × latency + 0.25 × reliability + 0.20 × bandwidth
 *   + 0.10 × uptime + 0.10 × diversity
 *
 * All factors are normalized to [0, 1] before weighting.
 */

import type { RelayNodeMetrics, ScoredRelayNode, NATType } from './types';

/** Scoring weight configuration */
export interface ScoringWeights {
  latency: number;
  reliability: number;
  bandwidth: number;
  uptime: number;
  diversity: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  latency: 0.35,
  reliability: 0.25,
  bandwidth: 0.20,
  uptime: 0.10,
  diversity: 0.10,
};

/** Latency thresholds for normalization */
const LATENCY_EXCELLENT = 50; // ms
const LATENCY_POOR = 2000; // ms

/** Bandwidth thresholds for normalization */
const BANDWIDTH_MIN = 100; // kbps
const BANDWIDTH_MAX = 10_000; // kbps

export class RelayScorer {
  private weights: ScoringWeights;
  private metrics = new Map<string, RelayNodeMetrics>();
  /** Set of known region hints for diversity calculation */
  private knownRegions = new Set<string>();

  constructor(weights: Partial<ScoringWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /** Update metrics for a node */
  updateMetrics(metrics: RelayNodeMetrics): void {
    this.metrics.set(metrics.nodeId, metrics);
    if (metrics.regionHint) {
      this.knownRegions.add(metrics.regionHint);
    }
  }

  /** Remove a node's metrics */
  removeNode(nodeId: string): void {
    this.metrics.delete(nodeId);
  }

  /** Score a single node */
  scoreNode(nodeId: string): ScoredRelayNode | null {
    const m = this.metrics.get(nodeId);
    if (!m) return null;
    return this.computeScore(m);
  }

  /** Score all known nodes, sorted by score descending */
  scoreAll(): ScoredRelayNode[] {
    const scored: ScoredRelayNode[] = [];
    for (const m of this.metrics.values()) {
      scored.push(this.computeScore(m));
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /** Get top N relay nodes by score */
  getTopRelays(count: number): ScoredRelayNode[] {
    return this.scoreAll().slice(0, count);
  }

  /** Get nodes that meet a minimum score threshold */
  getQualifiedRelays(minScore: number): ScoredRelayNode[] {
    return this.scoreAll().filter((n) => n.score >= minScore);
  }

  /** Get the count of tracked nodes */
  getNodeCount(): number {
    return this.metrics.size;
  }

  /** Clear all metrics */
  clear(): void {
    this.metrics.clear();
    this.knownRegions.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private computeScore(m: RelayNodeMetrics): ScoredRelayNode {
    const factors = {
      latency: this.normalizeLatency(m.avgLatency),
      reliability: m.reliability, // already 0-1
      bandwidth: this.normalizeBandwidth(m.bandwidth),
      uptime: m.uptimeRatio, // already 0-1
      diversity: this.computeDiversity(m),
    };

    const score =
      factors.latency * this.weights.latency +
      factors.reliability * this.weights.reliability +
      factors.bandwidth * this.weights.bandwidth +
      factors.uptime * this.weights.uptime +
      factors.diversity * this.weights.diversity;

    return {
      nodeId: m.nodeId,
      score: Math.max(0, Math.min(1, score)),
      factors,
      metrics: m,
    };
  }

  /** Normalize latency: lower is better (inverse scale) */
  private normalizeLatency(latencyMs: number): number {
    if (latencyMs <= LATENCY_EXCELLENT) return 1.0;
    if (latencyMs >= LATENCY_POOR) return 0.0;
    return 1 - (latencyMs - LATENCY_EXCELLENT) / (LATENCY_POOR - LATENCY_EXCELLENT);
  }

  /** Normalize bandwidth: higher is better */
  private normalizeBandwidth(kbps: number): number {
    if (kbps >= BANDWIDTH_MAX) return 1.0;
    if (kbps <= BANDWIDTH_MIN) return 0.0;
    return (kbps - BANDWIDTH_MIN) / (BANDWIDTH_MAX - BANDWIDTH_MIN);
  }

  /** Compute diversity score based on region and NAT type */
  private computeDiversity(m: RelayNodeMetrics): number {
    let score = 0.5; // Base score

    // NAT type bonus (open/full-cone are more useful as relays)
    score += this.natTypeBonus(m.natType) * 0.3;

    // Region diversity bonus (rare regions score higher)
    if (m.regionHint && this.knownRegions.size > 1) {
      // Count how many nodes share this region
      let regionCount = 0;
      for (const other of this.metrics.values()) {
        if (other.regionHint === m.regionHint) regionCount++;
      }
      // Rarer regions get higher diversity score
      const regionRarity = 1 - regionCount / this.metrics.size;
      score += regionRarity * 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  private natTypeBonus(natType: NATType): number {
    switch (natType) {
      case 'open': return 1.0;
      case 'full-cone': return 0.8;
      case 'restricted': return 0.5;
      case 'port-restricted': return 0.3;
      case 'symmetric': return 0.0;
      case 'unknown': return 0.2;
    }
  }
}
