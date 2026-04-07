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

export class AdaptiveTopologyManager {
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
   */
  getStrategy(participantCount: number): TopologyStrategy {
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
    const newStrategy = this.getStrategy(participantCount);
    return this.strategyRank(newStrategy) > this.strategyRank(currentStrategy);
  }

  /**
   * Whether the topology should downgrade.
   */
  shouldDowngrade(
    currentStrategy: TopologyStrategy,
    participantCount: number
  ): boolean {
    const newStrategy = this.getStrategy(participantCount);
    return this.strategyRank(newStrategy) < this.strategyRank(currentStrategy);
  }

  /** Map strategy to numeric rank for comparison */
  private strategyRank(strategy: TopologyStrategy): number {
    const ranks: Record<TopologyStrategy, number> = {
      'direct': 0,
      'full-mesh': 1,
      'partial-mesh': 2,
      'super-node': 3,
    };
    return ranks[strategy];
  }
}
