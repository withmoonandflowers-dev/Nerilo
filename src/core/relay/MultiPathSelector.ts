/**
 * MultiPathSelector — Greedy independent path construction
 *
 * Selects 2-4 relay paths from sender to receiver that:
 * - Avoid sharing intermediate nodes (path independence)
 * - Maximize path diversity for redundancy
 * - Adapt path count based on network quality
 *
 * Path count logic:
 * - 2 paths: Stable network, good average quality
 * - 3 paths: Moderate network, some unreliable nodes
 * - 4 paths: Unstable network, many unreliable nodes
 */

import type { RelayPath, MultiPathSelection, ScoredRelayNode } from './types';

/** Minimum paths to select */
const MIN_PATHS = 2;
/** Maximum paths to select */
const MAX_PATHS = 4;
/** Minimum nodes available to enable multi-path */
const MIN_NODES_FOR_MULTIPATH = 3;

/** Network quality thresholds for path count decision */
const QUALITY_THRESHOLDS = {
  /** Average reliability above this → 2 paths sufficient */
  stableReliability: 0.85,
  /** Average reliability below this → use 4 paths */
  unstableReliability: 0.60,
};

export class MultiPathSelector {
  /**
   * Select multiple independent relay paths.
   *
   * @param scoredNodes All available relay nodes, pre-scored
   * @param senderId Sender's node ID (excluded from relay paths)
   * @param receiverId Receiver's node ID (excluded from relay paths)
   * @param maxHopsPerPath Maximum hops in each path (typically 2-3)
   * @returns Multi-path selection with 2-4 independent paths
   */
  selectPaths(
    scoredNodes: ScoredRelayNode[],
    senderId: string,
    receiverId: string,
    maxHopsPerPath = 2
  ): MultiPathSelection {
    // Filter out sender and receiver from relay candidates
    const candidates = scoredNodes.filter(
      (n) => n.nodeId !== senderId && n.nodeId !== receiverId
    );

    if (candidates.length < MIN_NODES_FOR_MULTIPATH) {
      return this.buildDegradedSelection(candidates, senderId, receiverId);
    }

    // Determine how many paths based on network quality
    const pathCount = this.determinePathCount(candidates);
    const pathCountReason = this.getPathCountReason(candidates, pathCount);

    // Greedy independent path construction
    const paths = this.greedyPathConstruction(
      candidates,
      pathCount,
      maxHopsPerPath,
      senderId,
      receiverId
    );

    return {
      paths,
      primaryPathIndex: 0, // Best-scored path is primary
      pathCountReason,
    };
  }

  /**
   * Build degraded selection when insufficient nodes.
   * Falls back to single-path or direct connection.
   */
  private buildDegradedSelection(
    candidates: ScoredRelayNode[],
    _senderId: string,
    _receiverId: string
  ): MultiPathSelection {
    if (candidates.length === 0) {
      // No relay nodes — direct connection only
      return {
        paths: [{
          pathId: this.generatePathId(),
          hops: [],
          estimatedLatency: 0,
          pathScore: 0,
          isActive: true,
          lastUsed: 0,
        }],
        primaryPathIndex: 0,
        pathCountReason: 'No relay nodes available — direct connection only',
      };
    }

    // 1-2 nodes: single relay path
    const path: RelayPath = {
      pathId: this.generatePathId(),
      hops: candidates.slice(0, 1).map((n) => n.nodeId),
      estimatedLatency: candidates[0]?.metrics.avgLatency ?? 0,
      pathScore: candidates[0]?.score ?? 0,
      isActive: true,
      lastUsed: 0,
    };

    return {
      paths: [path],
      primaryPathIndex: 0,
      pathCountReason: `Insufficient relay nodes (${candidates.length}) — single path`,
    };
  }

  /**
   * Determine the number of paths based on network quality.
   */
  private determinePathCount(candidates: ScoredRelayNode[]): number {
    const avgReliability =
      candidates.reduce((sum, n) => sum + n.metrics.reliability, 0) / candidates.length;

    if (avgReliability >= QUALITY_THRESHOLDS.stableReliability) {
      return Math.min(MIN_PATHS, candidates.length);
    }
    if (avgReliability <= QUALITY_THRESHOLDS.unstableReliability) {
      return Math.min(MAX_PATHS, Math.floor(candidates.length / 2));
    }
    // Moderate quality → 3 paths
    return Math.min(3, Math.floor(candidates.length / 2));
  }

  private getPathCountReason(candidates: ScoredRelayNode[], count: number): string {
    const avgReliability =
      candidates.reduce((sum, n) => sum + n.metrics.reliability, 0) / candidates.length;
    return `${count} paths selected (avg reliability: ${(avgReliability * 100).toFixed(1)}%, ${candidates.length} candidates)`;
  }

  /**
   * Greedy independent path construction.
   * Each subsequent path avoids nodes already used in previous paths.
   */
  private greedyPathConstruction(
    candidates: ScoredRelayNode[],
    pathCount: number,
    maxHops: number,
    _senderId: string,
    _receiverId: string
  ): RelayPath[] {
    const paths: RelayPath[] = [];
    const usedNodes = new Set<string>();

    for (let p = 0; p < pathCount; p++) {
      // Filter candidates not yet used in other paths
      const available = candidates.filter((n) => !usedNodes.has(n.nodeId));

      if (available.length === 0) break; // No more independent paths possible

      // Select hops for this path (best-scored available nodes)
      const hops: string[] = [];
      const hopCandidates = [...available].sort((a, b) => b.score - a.score);

      for (let h = 0; h < maxHops && h < hopCandidates.length; h++) {
        hops.push(hopCandidates[h].nodeId);
      }

      if (hops.length === 0) break;

      // Estimate latency as sum of hop latencies
      const estimatedLatency = hops.reduce((sum, hopId) => {
        const node = candidates.find((n) => n.nodeId === hopId);
        return sum + (node?.metrics.avgLatency ?? 100);
      }, 0);

      // Path score is the product of hop scores (chain reliability)
      const pathScore = hops.reduce((product, hopId) => {
        const node = candidates.find((n) => n.nodeId === hopId);
        return product * (node?.score ?? 0.5);
      }, 1);

      paths.push({
        pathId: this.generatePathId(),
        hops,
        estimatedLatency,
        pathScore,
        isActive: true,
        lastUsed: 0,
      });

      // Mark these nodes as used
      for (const hopId of hops) {
        usedNodes.add(hopId);
      }
    }

    // Sort by path score descending (best path first)
    paths.sort((a, b) => b.pathScore - a.pathScore);

    return paths;
  }

  private generatePathId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
