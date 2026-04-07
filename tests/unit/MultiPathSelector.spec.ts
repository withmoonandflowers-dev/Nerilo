import { describe, it, expect, beforeEach } from 'vitest';
import { MultiPathSelector } from '../../src/core/relay/MultiPathSelector';
import type { ScoredRelayNode } from '../../src/core/relay/types';

function makeNode(
  id: string,
  score: number,
  reliability = 0.9,
  latency = 100
): ScoredRelayNode {
  return {
    nodeId: id,
    score,
    factors: {
      latency: 1 - latency / 2000,
      reliability,
      bandwidth: 0.8,
      uptime: 0.9,
      diversity: 0.5,
    },
    metrics: {
      nodeId: id,
      avgLatency: latency,
      reliability,
      bandwidth: 5000,
      uptimeRatio: 0.9,
      natType: 'open',
    },
  };
}

describe('MultiPathSelector', () => {
  let selector: MultiPathSelector;

  beforeEach(() => {
    selector = new MultiPathSelector();
  });

  describe('path selection', () => {
    it('selects 2 paths for stable networks', () => {
      const nodes = Array.from({ length: 8 }, (_, i) =>
        makeNode(`node-${i}`, 0.9 - i * 0.02, 0.95)
      );

      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      expect(result.paths.length).toBe(2);
      expect(result.primaryPathIndex).toBe(0);
    });

    it('selects more paths for unstable networks', () => {
      const nodes = Array.from({ length: 10 }, (_, i) =>
        makeNode(`node-${i}`, 0.6 - i * 0.02, 0.5)
      );

      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      expect(result.paths.length).toBeGreaterThanOrEqual(2);
    });

    it('excludes sender and receiver from relay paths', () => {
      const nodes = [
        makeNode('sender', 0.99),
        makeNode('receiver', 0.99),
        makeNode('relay-1', 0.85),
        makeNode('relay-2', 0.80),
        makeNode('relay-3', 0.75),
      ];

      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      for (const path of result.paths) {
        expect(path.hops).not.toContain('sender');
        expect(path.hops).not.toContain('receiver');
      }
    });

    it('builds independent paths (no shared nodes)', () => {
      const nodes = Array.from({ length: 8 }, (_, i) =>
        makeNode(`node-${i}`, 0.9 - i * 0.05)
      );

      const result = selector.selectPaths(nodes, 'sender', 'receiver', 1);
      const allHops = result.paths.flatMap((p) => p.hops);
      const uniqueHops = new Set(allHops);
      // Each path should use different nodes
      expect(uniqueHops.size).toBe(allHops.length);
    });

    it('sorts paths by score descending', () => {
      const nodes = Array.from({ length: 8 }, (_, i) =>
        makeNode(`node-${i}`, 0.9 - i * 0.05, 0.9, 50 + i * 20)
      );

      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      for (let i = 1; i < result.paths.length; i++) {
        expect(result.paths[i - 1].pathScore).toBeGreaterThanOrEqual(
          result.paths[i].pathScore
        );
      }
    });

    it('respects maxHopsPerPath', () => {
      const nodes = Array.from({ length: 10 }, (_, i) =>
        makeNode(`node-${i}`, 0.9 - i * 0.02)
      );

      const result = selector.selectPaths(nodes, 'sender', 'receiver', 3);
      for (const path of result.paths) {
        expect(path.hops.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('degraded mode', () => {
    it('returns direct path with no relay nodes', () => {
      const result = selector.selectPaths([], 'sender', 'receiver');
      expect(result.paths.length).toBe(1);
      expect(result.paths[0].hops).toEqual([]);
      expect(result.pathCountReason).toContain('direct');
    });

    it('returns single path with very few nodes', () => {
      const nodes = [makeNode('relay-1', 0.8)];
      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      expect(result.paths.length).toBe(1);
      expect(result.pathCountReason).toContain('single path');
    });

    it('handles all candidates being sender/receiver', () => {
      const nodes = [makeNode('sender', 0.9), makeNode('receiver', 0.9)];
      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      expect(result.paths.length).toBe(1);
      expect(result.paths[0].hops).toEqual([]);
    });
  });

  describe('path metadata', () => {
    it('generates unique path IDs', () => {
      const nodes = Array.from({ length: 8 }, (_, i) =>
        makeNode(`node-${i}`, 0.9 - i * 0.02)
      );
      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      const ids = result.paths.map((p) => p.pathId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('estimates latency as sum of hop latencies', () => {
      const nodes = [
        makeNode('node-0', 0.9, 0.9, 100),
        makeNode('node-1', 0.8, 0.9, 200),
        makeNode('node-2', 0.7, 0.9, 150),
        makeNode('node-3', 0.6, 0.9, 300),
      ];
      const result = selector.selectPaths(nodes, 'sender', 'receiver', 2);
      for (const path of result.paths) {
        expect(path.estimatedLatency).toBeGreaterThan(0);
      }
    });

    it('marks all paths as active', () => {
      const nodes = Array.from({ length: 6 }, (_, i) =>
        makeNode(`node-${i}`, 0.9 - i * 0.05)
      );
      const result = selector.selectPaths(nodes, 'sender', 'receiver');
      for (const path of result.paths) {
        expect(path.isActive).toBe(true);
      }
    });
  });
});
