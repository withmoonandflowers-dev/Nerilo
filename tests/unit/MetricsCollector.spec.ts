import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../../src/core/metrics/MetricsCollector';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('delivery stats', () => {
    it('should track sent/received/dedup counts', () => {
      collector.recordSent();
      collector.recordSent();
      collector.recordReceived();
      collector.recordDeduplicated();

      const stats = collector.getDeliveryStats();
      expect(stats.sent).toBe(2);
      expect(stats.received).toBe(1);
      expect(stats.deduplicated).toBe(1);
    });

    it('should calculate avg and p99 latency', () => {
      for (let i = 1; i <= 100; i++) {
        collector.recordLatency(i);
      }

      const stats = collector.getDeliveryStats();
      expect(stats.avgLatencyMs).toBeCloseTo(50.5, 0);
      expect(stats.p99LatencyMs).toBe(100);
    });

    it('should handle empty latencies', () => {
      const stats = collector.getDeliveryStats();
      expect(stats.avgLatencyMs).toBe(0);
      expect(stats.p99LatencyMs).toBe(0);
    });
  });

  describe('gossip traces', () => {
    it('should store and retrieve traces', () => {
      collector.recordGossipTrace({
        messageId: 'm1',
        path: ['a', 'b', 'c'],
        hopCount: 2,
        totalLatencyMs: 50,
        timestamp: Date.now(),
      });

      const traces = collector.getGossipTraces();
      expect(traces.length).toBe(1);
      expect(traces[0].messageId).toBe('m1');
    });

    it('should cap at 50 traces', () => {
      for (let i = 0; i < 60; i++) {
        collector.recordGossipTrace({
          messageId: `m${i}`,
          path: ['a'],
          hopCount: 1,
          totalLatencyMs: 10,
          timestamp: Date.now(),
        });
      }

      expect(collector.getGossipTraces().length).toBe(50);
    });
  });

  describe('channel metrics', () => {
    it('should store and retrieve channel metrics', () => {
      collector.updateChannelMetrics({
        peerId: 'peer-a',
        kind: 'control',
        bufferedAmount: 1024,
        messagesPerSecond: 5,
        bytesPerSecond: 5120,
        backpressureEvents: 0,
      });

      const metrics = collector.getChannelMetrics();
      expect(metrics.length).toBe(1);
      expect(metrics[0].peerId).toBe('peer-a');
    });
  });

  describe('backpressure', () => {
    it('should track backpressure events', () => {
      collector.recordBackpressure();
      collector.recordBackpressure();
      expect(collector.getBackpressureCount()).toBe(2);
    });
  });

  describe('reset', () => {
    it('should clear all metrics', () => {
      collector.recordSent();
      collector.recordReceived();
      collector.recordLatency(100);
      collector.recordBackpressure();

      collector.reset();

      const stats = collector.getDeliveryStats();
      expect(stats.sent).toBe(0);
      expect(stats.received).toBe(0);
      expect(collector.getBackpressureCount()).toBe(0);
    });
  });
});
