/**
 * PathQualityTracker — Adaptive feedback loop for relay path optimization
 *
 * Tracks per-path and per-node delivery metrics over a rolling window.
 * Provides signals to MultiPathSelector and RelayScorer for
 * dynamic path adjustment.
 *
 * Metrics tracked per node:
 * - Success rate (successful relays / total attempts)
 * - First-arrival rate (how often this node's path wins)
 * - Average latency over the rolling window
 *
 * Window: Last 50 messages per node (configurable)
 */

/** Rolling window size per node */
const DEFAULT_WINDOW_SIZE = 50;

/** Minimum samples before a node's stats are considered reliable */
const MIN_SAMPLES = 5;

/** Score below which a node should be avoided */
const AVOIDANCE_THRESHOLD = 0.3;

interface DeliveryRecord {
  timestamp: number;
  latencyMs: number;
  success: boolean;
  wasFirstArrival: boolean;
}

interface NodeStats {
  nodeId: string;
  records: DeliveryRecord[];
}

interface PathStats {
  pathId: string;
  nodeIds: string[];
  records: DeliveryRecord[];
}

/** Computed quality metrics for a node */
export interface NodeQualityMetrics {
  nodeId: string;
  successRate: number;
  firstArrivalRate: number;
  avgLatency: number;
  sampleCount: number;
  isReliable: boolean; // has enough samples
}

/** Computed quality metrics for a path */
export interface PathQualityMetrics {
  pathId: string;
  successRate: number;
  firstArrivalRate: number;
  avgLatency: number;
  sampleCount: number;
  /** Product of node success rates along the path */
  chainReliability: number;
}

export class PathQualityTracker {
  private nodeStats = new Map<string, NodeStats>();
  private pathStats = new Map<string, PathStats>();
  private windowSize: number;

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  /**
   * Record a delivery attempt for a specific path.
   *
   * @param pathId The path that was used
   * @param nodeIds Nodes in the path
   * @param success Whether delivery succeeded
   * @param wasFirstArrival Whether this path delivered first
   * @param latencyMs End-to-end latency
   */
  recordDelivery(
    pathId: string,
    nodeIds: string[],
    success: boolean,
    wasFirstArrival: boolean,
    latencyMs: number
  ): void {
    const record: DeliveryRecord = {
      timestamp: Date.now(),
      latencyMs,
      success,
      wasFirstArrival,
    };

    // Record per-path
    let pathStat = this.pathStats.get(pathId);
    if (!pathStat) {
      pathStat = { pathId, nodeIds, records: [] };
      this.pathStats.set(pathId, pathStat);
    }
    pathStat.records.push(record);
    if (pathStat.records.length > this.windowSize) {
      pathStat.records.shift();
    }

    // Record per-node
    for (const nodeId of nodeIds) {
      let nodeStat = this.nodeStats.get(nodeId);
      if (!nodeStat) {
        nodeStat = { nodeId, records: [] };
        this.nodeStats.set(nodeId, nodeStat);
      }
      nodeStat.records.push(record);
      if (nodeStat.records.length > this.windowSize) {
        nodeStat.records.shift();
      }
    }
  }

  /** Get quality metrics for a specific node */
  getNodeMetrics(nodeId: string): NodeQualityMetrics | null {
    const stat = this.nodeStats.get(nodeId);
    if (!stat || stat.records.length === 0) return null;

    return this.computeNodeMetrics(stat);
  }

  /** Get quality metrics for a specific path */
  getPathMetrics(pathId: string): PathQualityMetrics | null {
    const stat = this.pathStats.get(pathId);
    if (!stat || stat.records.length === 0) return null;

    return this.computePathMetrics(stat);
  }

  /** Get all node metrics, sorted by success rate descending */
  getAllNodeMetrics(): NodeQualityMetrics[] {
    const metrics: NodeQualityMetrics[] = [];
    for (const stat of this.nodeStats.values()) {
      if (stat.records.length > 0) {
        metrics.push(this.computeNodeMetrics(stat));
      }
    }
    metrics.sort((a, b) => b.successRate - a.successRate);
    return metrics;
  }

  /** Get all path metrics, sorted by success rate descending */
  getAllPathMetrics(): PathQualityMetrics[] {
    const metrics: PathQualityMetrics[] = [];
    for (const stat of this.pathStats.values()) {
      if (stat.records.length > 0) {
        metrics.push(this.computePathMetrics(stat));
      }
    }
    metrics.sort((a, b) => b.successRate - a.successRate);
    return metrics;
  }

  /** Get nodes that should be avoided (poor quality) */
  getAvoidanceList(): string[] {
    const avoid: string[] = [];
    for (const stat of this.nodeStats.values()) {
      if (stat.records.length < MIN_SAMPLES) continue;
      const metrics = this.computeNodeMetrics(stat);
      if (metrics.successRate < AVOIDANCE_THRESHOLD) {
        avoid.push(stat.nodeId);
      }
    }
    return avoid;
  }

  /** Check if a node should be avoided */
  shouldAvoid(nodeId: string): boolean {
    const stat = this.nodeStats.get(nodeId);
    if (!stat || stat.records.length < MIN_SAMPLES) return false;
    const metrics = this.computeNodeMetrics(stat);
    return metrics.successRate < AVOIDANCE_THRESHOLD;
  }

  /** Remove a node's tracking data */
  removeNode(nodeId: string): void {
    this.nodeStats.delete(nodeId);
  }

  /** Remove a path's tracking data */
  removePath(pathId: string): void {
    this.pathStats.delete(pathId);
  }

  /** Get the count of tracked nodes */
  getNodeCount(): number {
    return this.nodeStats.size;
  }

  /** Clear all tracking data */
  clear(): void {
    this.nodeStats.clear();
    this.pathStats.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private computeNodeMetrics(stat: NodeStats): NodeQualityMetrics {
    const records = stat.records;
    const total = records.length;
    const successes = records.filter((r) => r.success).length;
    const firstArrivals = records.filter((r) => r.wasFirstArrival).length;
    const avgLatency =
      records.reduce((sum, r) => sum + r.latencyMs, 0) / total;

    return {
      nodeId: stat.nodeId,
      successRate: total > 0 ? successes / total : 0,
      firstArrivalRate: total > 0 ? firstArrivals / total : 0,
      avgLatency,
      sampleCount: total,
      isReliable: total >= MIN_SAMPLES,
    };
  }

  private computePathMetrics(stat: PathStats): PathQualityMetrics {
    const records = stat.records;
    const total = records.length;
    const successes = records.filter((r) => r.success).length;
    const firstArrivals = records.filter((r) => r.wasFirstArrival).length;
    const avgLatency =
      records.reduce((sum, r) => sum + r.latencyMs, 0) / total;

    // Chain reliability: product of individual node success rates
    let chainReliability = 1;
    for (const nodeId of stat.nodeIds) {
      const nodeMetrics = this.getNodeMetrics(nodeId);
      if (nodeMetrics && nodeMetrics.isReliable) {
        chainReliability *= nodeMetrics.successRate;
      }
    }

    return {
      pathId: stat.pathId,
      successRate: total > 0 ? successes / total : 0,
      firstArrivalRate: total > 0 ? firstArrivals / total : 0,
      avgLatency,
      sampleCount: total,
      chainReliability,
    };
  }
}
