/**
 * Metrics Collector
 * Centralized metrics gathering for debug panel and monitoring.
 */

export interface GossipTrace {
  messageId: string;
  path: string[];
  hopCount: number;
  totalLatencyMs: number;
  timestamp: number;
}

export interface ChannelMetrics {
  peerId: string;
  kind: string;
  bufferedAmount: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  backpressureEvents: number;
}

export interface DeliveryStats {
  sent: number;
  received: number;
  deduplicated: number;
  reachabilityPercent: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
}

export interface MetricsSnapshot {
  /** Number of distinct peer/channel pairs with traffic recently */
  activeChannels: number;
  /** Messages-per-second across all channels (last update) */
  msgsPerSec: number;
  /** Cumulative latency percentiles in milliseconds */
  latency: { p50: number; p95: number; p99: number; avg: number; samples: number };
  /** Counts of hop length seen in recent gossip traces (hops → count) */
  hopDistribution: Record<number, number>;
  /** Per-channel bufferedAmount snapshot — peer:kind → bytes */
  buffer: Record<string, number>;
  /** Reachability % (1 - dedup/total) */
  reachabilityPercent: number;
  /** Cumulative counters */
  totals: { sent: number; received: number; deduplicated: number; backpressure: number };
}

export interface MeshTopologySnapshot {
  localPeerId: string;
  strategy: string;
  neighbors: { peerId: string; rttMs: number | null; quality: string }[];
  superNodes: string[];
  participantCount: number;
}

const MAX_GOSSIP_TRACES = 50;

export class MetricsCollector {
  private gossipTraces: GossipTrace[] = [];
  private latencies: number[] = [];
  private sentCount = 0;
  private receivedCount = 0;
  private dedupCount = 0;
  private channelMetrics = new Map<string, ChannelMetrics>();
  private backpressureCount = 0;

  // ── Record methods ────────────────────────────────────────────────────────

  recordSent(): void {
    this.sentCount++;
  }

  recordReceived(): void {
    this.receivedCount++;
  }

  recordDeduplicated(): void {
    this.dedupCount++;
  }

  recordLatency(ms: number): void {
    this.latencies.push(ms);
    // Keep bounded
    if (this.latencies.length > 1000) {
      this.latencies = this.latencies.slice(-500);
    }
  }

  recordGossipTrace(trace: GossipTrace): void {
    this.gossipTraces.push(trace);
    if (this.gossipTraces.length > MAX_GOSSIP_TRACES) {
      this.gossipTraces.shift();
    }
  }

  recordBackpressure(): void {
    this.backpressureCount++;
  }

  updateChannelMetrics(metrics: ChannelMetrics): void {
    const key = `${metrics.peerId}:${metrics.kind}`;
    this.channelMetrics.set(key, metrics);
  }

  // ── Query methods ─────────────────────────────────────────────────────────

  getDeliveryStats(): DeliveryStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const avg =
      sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const p99 =
      sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0;
    const total = this.sentCount + this.receivedCount;
    const reachability = total > 0 ? ((total - this.dedupCount) / total) * 100 : 100;

    return {
      sent: this.sentCount,
      received: this.receivedCount,
      deduplicated: this.dedupCount,
      reachabilityPercent: Math.round(reachability * 100) / 100,
      avgLatencyMs: Math.round(avg * 100) / 100,
      p99LatencyMs: p99,
    };
  }

  getGossipTraces(): GossipTrace[] {
    return [...this.gossipTraces];
  }

  getChannelMetrics(): ChannelMetrics[] {
    return Array.from(this.channelMetrics.values());
  }

  getBackpressureCount(): number {
    return this.backpressureCount;
  }

  /**
   * Aggregate snapshot suitable for periodic console export or a /metrics
   * debug panel. Combines latency percentiles, hop distribution, channel
   * buffer state, and throughput into a single shape.
   */
  getSnapshot(): MetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const avg = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;

    const hopDistribution: Record<number, number> = {};
    for (const t of this.gossipTraces) {
      hopDistribution[t.hopCount] = (hopDistribution[t.hopCount] ?? 0) + 1;
    }

    const channels = Array.from(this.channelMetrics.values());
    const buffer: Record<string, number> = {};
    let msgsPerSec = 0;
    for (const c of channels) {
      buffer[`${c.peerId}:${c.kind}`] = c.bufferedAmount;
      msgsPerSec += c.messagesPerSecond;
    }

    const total = this.sentCount + this.receivedCount;
    const reachabilityPercent =
      total > 0 ? Math.round(((total - this.dedupCount) / total) * 10000) / 100 : 100;

    return {
      activeChannels: channels.length,
      msgsPerSec: Math.round(msgsPerSec * 100) / 100,
      latency: {
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
        avg: Math.round(avg * 100) / 100,
        samples: sorted.length,
      },
      hopDistribution,
      buffer,
      reachabilityPercent,
      totals: {
        sent: this.sentCount,
        received: this.receivedCount,
        deduplicated: this.dedupCount,
        backpressure: this.backpressureCount,
      },
    };
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  reset(): void {
    this.gossipTraces = [];
    this.latencies = [];
    this.sentCount = 0;
    this.receivedCount = 0;
    this.dedupCount = 0;
    this.channelMetrics.clear();
    this.backpressureCount = 0;
  }
}

/** Singleton instance */
export const metricsCollector = new MetricsCollector();
