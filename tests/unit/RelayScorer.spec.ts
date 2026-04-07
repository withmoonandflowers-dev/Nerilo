import { describe, it, expect, beforeEach } from 'vitest';
import { RelayScorer } from '../../src/core/relay/RelayScorer';

describe('RelayScorer', () => {
  let scorer: RelayScorer;

  beforeEach(() => {
    scorer = new RelayScorer();
  });

  describe('scoring', () => {
    it('scores a node with good metrics highly', () => {
      scorer.updateMetrics({
        nodeId: 'good-node',
        avgLatency: 30,
        reliability: 0.99,
        bandwidth: 8000,
        uptimeRatio: 0.95,
        natType: 'open',
      });

      const result = scorer.scoreNode('good-node');
      expect(result).toBeDefined();
      expect(result!.score).toBeGreaterThan(0.8);
    });

    it('scores a node with poor metrics low', () => {
      scorer.updateMetrics({
        nodeId: 'bad-node',
        avgLatency: 1500,
        reliability: 0.3,
        bandwidth: 200,
        uptimeRatio: 0.2,
        natType: 'symmetric',
      });

      const result = scorer.scoreNode('bad-node');
      expect(result).toBeDefined();
      expect(result!.score).toBeLessThan(0.3);
    });

    it('returns null for unknown node', () => {
      expect(scorer.scoreNode('unknown')).toBeNull();
    });
  });

  describe('ranking', () => {
    it('ranks nodes by score descending', () => {
      scorer.updateMetrics({
        nodeId: 'fast',
        avgLatency: 20,
        reliability: 0.99,
        bandwidth: 10000,
        uptimeRatio: 0.99,
        natType: 'open',
      });
      scorer.updateMetrics({
        nodeId: 'slow',
        avgLatency: 1000,
        reliability: 0.5,
        bandwidth: 500,
        uptimeRatio: 0.5,
        natType: 'restricted',
      });

      const all = scorer.scoreAll();
      expect(all[0].nodeId).toBe('fast');
      expect(all[1].nodeId).toBe('slow');
    });

    it('returns top N relays', () => {
      for (let i = 0; i < 5; i++) {
        scorer.updateMetrics({
          nodeId: `node-${i}`,
          avgLatency: 50 + i * 100,
          reliability: 0.9 - i * 0.1,
          bandwidth: 5000,
          uptimeRatio: 0.8,
          natType: 'open',
        });
      }

      const top = scorer.getTopRelays(2);
      expect(top).toHaveLength(2);
      expect(top[0].score).toBeGreaterThanOrEqual(top[1].score);
    });
  });

  describe('qualified relays', () => {
    it('filters by minimum score', () => {
      scorer.updateMetrics({
        nodeId: 'good',
        avgLatency: 30,
        reliability: 0.99,
        bandwidth: 8000,
        uptimeRatio: 0.95,
        natType: 'open',
      });
      scorer.updateMetrics({
        nodeId: 'bad',
        avgLatency: 2000,
        reliability: 0.1,
        bandwidth: 100,
        uptimeRatio: 0.1,
        natType: 'symmetric',
      });

      const qualified = scorer.getQualifiedRelays(0.5);
      expect(qualified).toHaveLength(1);
      expect(qualified[0].nodeId).toBe('good');
    });
  });

  describe('latency normalization', () => {
    it('gives max score for excellent latency', () => {
      scorer.updateMetrics({
        nodeId: 'fast',
        avgLatency: 10,
        reliability: 0.5,
        bandwidth: 1000,
        uptimeRatio: 0.5,
        natType: 'open',
      });
      const result = scorer.scoreNode('fast')!;
      expect(result.factors.latency).toBe(1.0);
    });

    it('gives min score for very poor latency', () => {
      scorer.updateMetrics({
        nodeId: 'slow',
        avgLatency: 3000,
        reliability: 0.5,
        bandwidth: 1000,
        uptimeRatio: 0.5,
        natType: 'open',
      });
      const result = scorer.scoreNode('slow')!;
      expect(result.factors.latency).toBe(0.0);
    });
  });

  describe('cleanup', () => {
    it('clears all metrics', () => {
      scorer.updateMetrics({
        nodeId: 'node-1',
        avgLatency: 50,
        reliability: 0.9,
        bandwidth: 5000,
        uptimeRatio: 0.8,
        natType: 'open',
      });
      scorer.clear();
      expect(scorer.getNodeCount()).toBe(0);
    });
  });
});
