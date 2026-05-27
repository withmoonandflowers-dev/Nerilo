/**
 * MetricsExporter unit tests
 *
 * Covers the snapshot shape produced by MetricsCollector.getSnapshot() and the
 * periodic exporter scheduler. The console sink is replaced with a spy so the
 * tests assert structure, not console output formatting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from '../../src/core/metrics/MetricsCollector';
import { startMetricsExporter } from '../../src/core/metrics/MetricsExporter';

describe('MetricsCollector.getSnapshot', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it('returns empty defaults when nothing recorded', () => {
    const snap = collector.getSnapshot();
    expect(snap.activeChannels).toBe(0);
    expect(snap.msgsPerSec).toBe(0);
    expect(snap.latency.samples).toBe(0);
    expect(snap.latency.p50).toBe(0);
    expect(snap.latency.p95).toBe(0);
    expect(snap.reachabilityPercent).toBe(100);
    expect(snap.hopDistribution).toEqual({});
    expect(snap.buffer).toEqual({});
  });

  it('computes p50 / p95 / p99 from recorded latencies', () => {
    for (let i = 1; i <= 100; i++) collector.recordLatency(i);
    const { latency } = collector.getSnapshot();
    expect(latency.samples).toBe(100);
    expect(latency.p50).toBe(51);
    expect(latency.p95).toBe(96);
    expect(latency.p99).toBe(100);
    expect(latency.avg).toBeCloseTo(50.5, 0);
  });

  it('aggregates hop-count distribution from gossip traces', () => {
    const trace = (hops: number) => ({
      messageId: `m-${hops}-${Math.random()}`,
      path: Array.from({ length: hops }, (_, i) => `p${i}`),
      hopCount: hops,
      totalLatencyMs: 10,
      timestamp: Date.now(),
    });
    collector.recordGossipTrace(trace(1));
    collector.recordGossipTrace(trace(2));
    collector.recordGossipTrace(trace(2));
    collector.recordGossipTrace(trace(3));

    const { hopDistribution } = collector.getSnapshot();
    expect(hopDistribution).toEqual({ 1: 1, 2: 2, 3: 1 });
  });

  it('exposes channel buffer state and active channel count', () => {
    collector.updateChannelMetrics({
      peerId: 'peer-a', kind: 'control', bufferedAmount: 128,
      messagesPerSecond: 4, bytesPerSecond: 1000, backpressureEvents: 0,
    });
    collector.updateChannelMetrics({
      peerId: 'peer-b', kind: 'bulk', bufferedAmount: 4096,
      messagesPerSecond: 2, bytesPerSecond: 50000, backpressureEvents: 1,
    });

    const snap = collector.getSnapshot();
    expect(snap.activeChannels).toBe(2);
    expect(snap.msgsPerSec).toBe(6);
    expect(snap.buffer).toEqual({ 'peer-a:control': 128, 'peer-b:bulk': 4096 });
  });

  it('reflects send/receive/dedup totals and reachability', () => {
    collector.recordSent();
    collector.recordSent();
    collector.recordReceived();
    collector.recordReceived();
    collector.recordReceived();
    collector.recordDeduplicated(); // 1 dedup out of 5 events → 80% reachability
    collector.recordBackpressure();

    const snap = collector.getSnapshot();
    expect(snap.totals).toEqual({ sent: 2, received: 3, deduplicated: 1, backpressure: 1 });
    expect(snap.reachabilityPercent).toBe(80);
  });
});

describe('startMetricsExporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls the sink on the configured interval and stops on stop()', () => {
    const sink = vi.fn();
    const source = { getSnapshot: vi.fn(() => ({
      activeChannels: 0, msgsPerSec: 0,
      latency: { p50: 0, p95: 0, p99: 0, avg: 0, samples: 0 },
      hopDistribution: {}, buffer: {},
      reachabilityPercent: 100,
      totals: { sent: 0, received: 0, deduplicated: 0, backpressure: 0 },
    })) };

    const handle = startMetricsExporter({ intervalMs: 1000, sink, source });
    expect(sink).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3500);
    expect(sink).toHaveBeenCalledTimes(3);
    expect(source.getSnapshot).toHaveBeenCalledTimes(3);

    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(sink).toHaveBeenCalledTimes(3); // no new calls after stop
  });

  it('is idempotent — repeated start returns the same handle', () => {
    const sink = vi.fn();
    const h1 = startMetricsExporter({ intervalMs: 1000, sink });
    const h2 = startMetricsExporter({ intervalMs: 500, sink });
    expect(h1).toBe(h2);
    h1.stop();
  });

  it('catches sink errors and keeps running', () => {
    const sink = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const source = { getSnapshot: vi.fn(() => ({
      activeChannels: 0, msgsPerSec: 0,
      latency: { p50: 0, p95: 0, p99: 0, avg: 0, samples: 0 },
      hopDistribution: {}, buffer: {},
      reachabilityPercent: 100,
      totals: { sent: 0, received: 0, deduplicated: 0, backpressure: 0 },
    })) };

    const handle = startMetricsExporter({ intervalMs: 100, sink, source });
    vi.advanceTimersByTime(350);
    // First call threw, subsequent calls still fire
    expect(sink).toHaveBeenCalledTimes(3);
    handle.stop();
  });
});
