import { describe, it, expect, beforeEach } from 'vitest';
import { PathQualityTracker } from '../../src/core/relay/PathQualityTracker';

describe('PathQualityTracker', () => {
  let tracker: PathQualityTracker;

  beforeEach(() => {
    tracker = new PathQualityTracker(10); // Small window for testing
  });

  describe('node metrics', () => {
    it('returns null for unknown node', () => {
      expect(tracker.getNodeMetrics('unknown')).toBeNull();
    });

    it('tracks successful deliveries', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordDelivery('path-1', ['node-a'], true, i === 0, 100);
      }

      const metrics = tracker.getNodeMetrics('node-a');
      expect(metrics).toBeDefined();
      expect(metrics!.successRate).toBe(1.0);
      expect(metrics!.sampleCount).toBe(5);
      expect(metrics!.isReliable).toBe(true);
    });

    it('tracks failures', () => {
      tracker.recordDelivery('path-1', ['node-a'], true, true, 100);
      tracker.recordDelivery('path-1', ['node-a'], false, false, 0);

      const metrics = tracker.getNodeMetrics('node-a');
      expect(metrics!.successRate).toBe(0.5);
    });

    it('tracks first arrival rate', () => {
      tracker.recordDelivery('path-1', ['node-a'], true, true, 100);
      tracker.recordDelivery('path-1', ['node-a'], true, false, 100);
      tracker.recordDelivery('path-1', ['node-a'], true, true, 100);

      const metrics = tracker.getNodeMetrics('node-a');
      expect(metrics!.firstArrivalRate).toBeCloseTo(2 / 3);
    });

    it('calculates average latency', () => {
      tracker.recordDelivery('path-1', ['node-a'], true, true, 100);
      tracker.recordDelivery('path-1', ['node-a'], true, false, 200);
      tracker.recordDelivery('path-1', ['node-a'], true, false, 300);

      const metrics = tracker.getNodeMetrics('node-a');
      expect(metrics!.avgLatency).toBe(200);
    });

    it('respects rolling window size', () => {
      // Window is 10, add 15 records
      for (let i = 0; i < 15; i++) {
        tracker.recordDelivery('path-1', ['node-a'], true, false, 100);
      }

      const metrics = tracker.getNodeMetrics('node-a');
      expect(metrics!.sampleCount).toBe(10); // Capped at window
    });
  });

  describe('path metrics', () => {
    it('tracks path-level statistics', () => {
      tracker.recordDelivery('path-1', ['node-a', 'node-b'], true, true, 150);
      tracker.recordDelivery('path-1', ['node-a', 'node-b'], true, false, 200);

      const metrics = tracker.getPathMetrics('path-1');
      expect(metrics).toBeDefined();
      expect(metrics!.successRate).toBe(1.0);
      expect(metrics!.avgLatency).toBe(175);
    });
  });

  describe('avoidance list', () => {
    it('avoids nodes with low success rate', () => {
      // 5+ samples required, all failures
      for (let i = 0; i < 6; i++) {
        tracker.recordDelivery('path-1', ['bad-node'], false, false, 0);
      }

      expect(tracker.shouldAvoid('bad-node')).toBe(true);
      expect(tracker.getAvoidanceList()).toContain('bad-node');
    });

    it('does not avoid nodes with insufficient samples', () => {
      tracker.recordDelivery('path-1', ['new-node'], false, false, 0);
      expect(tracker.shouldAvoid('new-node')).toBe(false);
    });

    it('does not avoid reliable nodes', () => {
      for (let i = 0; i < 6; i++) {
        tracker.recordDelivery('path-1', ['good-node'], true, true, 50);
      }
      expect(tracker.shouldAvoid('good-node')).toBe(false);
    });
  });

  describe('rankings', () => {
    it('ranks nodes by success rate', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordDelivery('path-1', ['good-node'], true, true, 50);
        tracker.recordDelivery('path-2', ['bad-node'], false, false, 0);
      }

      const ranked = tracker.getAllNodeMetrics();
      expect(ranked[0].nodeId).toBe('good-node');
      expect(ranked[1].nodeId).toBe('bad-node');
    });
  });

  describe('cleanup', () => {
    it('clears all data', () => {
      tracker.recordDelivery('path-1', ['node-a'], true, true, 100);
      tracker.clear();
      expect(tracker.getNodeCount()).toBe(0);
      expect(tracker.getNodeMetrics('node-a')).toBeNull();
    });

    it('removes individual nodes', () => {
      tracker.recordDelivery('path-1', ['node-a'], true, true, 100);
      tracker.removeNode('node-a');
      expect(tracker.getNodeMetrics('node-a')).toBeNull();
    });
  });
});
