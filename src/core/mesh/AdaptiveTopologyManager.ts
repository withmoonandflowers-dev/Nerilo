/**
 * 自適應拓撲管理器
 * 根據房間參與者人數自動切換拓撲策略及 gossip 參數
 */

export type TopologyStrategy = 'direct' | 'full-mesh' | 'partial-mesh' | 'super-node';

export interface GossipConfig {
  /** Number of neighbors to forward messages to */
  fanout: number;
  /** Max hop count for gossip messages */
  ttl: number;
}

export interface TopologyEvaluation {
  strategy: TopologyStrategy;
  targetNeighborCount: number;
  gossipConfig: GossipConfig;
}

/**
 * Hysteresis bands to prevent topology thrashing at boundaries.
 * Upgrade at the upper threshold, downgrade at the lower threshold.
 * Example: full-mesh upgrades at 8, but partial-mesh only downgrades at 4.
 */
const TOPOLOGY_THRESHOLDS = {
  direct:       { upgradeAt: 3 },                    // → full-mesh at 3
  'full-mesh':  { upgradeAt: 8,  downgradeAt: 2 },   // → partial-mesh at 8, → direct at <=2
  'partial-mesh': { upgradeAt: 22, downgradeAt: 5 },  // → super-node at 22, → full-mesh at <=5
  'super-node': { downgradeAt: 18 },                   // → partial-mesh at <=18
} as const;

export class AdaptiveTopologyManager {
  private currentStrategy: TopologyStrategy | null = null;

  /**
   * Evaluate topology strategy based on participant count.
   */
  evaluateTopology(participantCount: number): TopologyEvaluation {
    const strategy = this.getStrategy(participantCount);
    return {
      strategy,
      targetNeighborCount: this.getTargetNeighborCount(participantCount),
      gossipConfig: this.getGossipConfig(participantCount),
    };
  }

  /**
   * Determine the topology strategy for a given participant count.
   * Uses hysteresis to prevent thrashing at boundary values.
   */
  getStrategy(participantCount: number): TopologyStrategy {
    // First call: use raw thresholds (no hysteresis)
    if (this.currentStrategy === null) {
      const strategy = this.getRawStrategy(participantCount);
      this.currentStrategy = strategy;
      return strategy;
    }

    // Subsequent calls: apply hysteresis
    const thresholds = TOPOLOGY_THRESHOLDS[this.currentStrategy];
    let newStrategy = this.currentStrategy;

    if ('upgradeAt' in thresholds && participantCount >= thresholds.upgradeAt) {
      newStrategy = this.getRawStrategy(participantCount);
    } else if ('downgradeAt' in thresholds && participantCount <= thresholds.downgradeAt) {
      newStrategy = this.getRawStrategy(participantCount);
    }

    this.currentStrategy = newStrategy;
    return newStrategy;
  }

  /**
   * Raw strategy without hysteresis (used for initial evaluation).
   */
  private getRawStrategy(participantCount: number): TopologyStrategy {
    if (participantCount <= 2) return 'direct';
    if (participantCount <= 6) return 'full-mesh';
    if (participantCount <= 20) return 'partial-mesh';
    return 'super-node';
  }

  /**
   * Calculate the target number of neighbor connections (k).
   */
  getTargetNeighborCount(participantCount: number): number {
    if (participantCount <= 1) return 0;
    if (participantCount <= 2) return 1; // direct: connect to the other peer
    if (participantCount <= 6) return participantCount - 1; // full-mesh: everyone
    if (participantCount <= 20) return Math.max(3, Math.ceil(Math.sqrt(participantCount)));
    // super-node: ordinary peers connect to ~5, super nodes handle more
    return 5;
  }

  /**
   * Get gossip configuration adapted to current network size.
   */
  getGossipConfig(participantCount: number): GossipConfig {
    if (participantCount <= 6) {
      return { fanout: Math.max(1, participantCount - 1), ttl: 1 };
    }
    if (participantCount <= 12) {
      return { fanout: 3, ttl: 3 };
    }
    if (participantCount <= 20) {
      return { fanout: 3, ttl: 4 };
    }
    return { fanout: 4, ttl: 5 };
  }

  /**
   * Whether the topology should upgrade (current strategy → new strategy)
   * based on participant count change.
   */
  shouldUpgrade(
    currentStrategy: TopologyStrategy,
    participantCount: number
  ): boolean {
    const thresholds = TOPOLOGY_THRESHOLDS[currentStrategy];
    if ('upgradeAt' in thresholds && participantCount >= thresholds.upgradeAt) {
      return true;
    }
    return false;
  }

  /**
   * Whether the topology should downgrade.
   */
  shouldDowngrade(
    currentStrategy: TopologyStrategy,
    participantCount: number
  ): boolean {
    const thresholds = TOPOLOGY_THRESHOLDS[currentStrategy];
    if ('downgradeAt' in thresholds && participantCount <= thresholds.downgradeAt) {
      return true;
    }
    return false;
  }

}
