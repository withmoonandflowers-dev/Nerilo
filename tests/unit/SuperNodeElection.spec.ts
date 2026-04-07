import { describe, it, expect } from 'vitest';
import {
  SuperNodeElection,
  type PeerScore,
  SUPER_NODE_MAX_CONNECTIONS,
  REGULAR_NODE_MAX_CONNECTIONS,
} from '../../src/core/mesh/SuperNodeElection';

function makePeer(
  peerId: string,
  overrides: Partial<PeerScore> = {}
): PeerScore {
  return {
    peerId,
    uptimeSeconds: 3600,
    bandwidthKbps: 1000,
    latencyMs: 100,
    batteryLevel: 0.8,
    natType: 'open',
    ...overrides,
  };
}

describe('SuperNodeElection', () => {
  const election = new SuperNodeElection();

  describe('computeScore()', () => {
    it('should return a score between 0 and 1', () => {
      const peers = [makePeer('a'), makePeer('b')];
      const score = election.computeScore(peers[0], peers);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should give higher score to peer with better stats', () => {
      const good = makePeer('good', {
        uptimeSeconds: 7200,
        bandwidthKbps: 5000,
        latencyMs: 20,
        batteryLevel: 1.0,
        natType: 'open',
      });
      const bad = makePeer('bad', {
        uptimeSeconds: 60,
        bandwidthKbps: 100,
        latencyMs: 2000,
        batteryLevel: 0.1,
        natType: 'symmetric',
      });
      const peers = [good, bad];

      const goodScore = election.computeScore(good, peers);
      const badScore = election.computeScore(bad, peers);
      expect(goodScore).toBeGreaterThan(badScore);
    });

    it('should handle null battery gracefully', () => {
      const peer = makePeer('a', { batteryLevel: null });
      const score = election.computeScore(peer, [peer]);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('elect()', () => {
    it('should return empty for <= 20 participants', () => {
      const peers = Array.from({ length: 15 }, (_, i) => makePeer(`p${i}`));
      const result = election.elect(peers, 15);
      expect(result.superNodes).toEqual([]);
    });

    it('should elect ceil(n/10) super nodes for > 20 participants', () => {
      const peers = Array.from({ length: 25 }, (_, i) => makePeer(`p${i}`));
      const result = election.elect(peers, 25);
      // ceil(25/10) = 3
      expect(result.superNodes.length).toBe(3);
    });

    it('should produce deterministic results (same input → same output)', () => {
      const peers = Array.from({ length: 30 }, (_, i) =>
        makePeer(`p${String(i).padStart(2, '0')}`, {
          uptimeSeconds: 100 + i * 10,
          latencyMs: 200 - i,
        })
      );

      const r1 = election.elect(peers, 30);
      const r2 = election.elect(peers, 30);
      expect(r1.superNodes).toEqual(r2.superNodes);
    });

    it('should use peerId as tiebreaker when scores are equal', () => {
      const peers = [
        makePeer('zzz'),
        makePeer('aaa'),
        makePeer('mmm'),
      ];
      // All peers have identical stats → equal scores → sort by peerId
      const result = election.elect(peers, 25);
      // ceil(25/10)=3 → all are super nodes, sorted by peerId asc (after equal scores)
      expect(result.superNodes).toEqual(['aaa', 'mmm', 'zzz']);
    });

    it('should handle empty peer list', () => {
      const result = election.elect([], 25);
      expect(result.superNodes).toEqual([]);
    });

    it('should elect for large rooms (50 peers)', () => {
      const peers = Array.from({ length: 50 }, (_, i) => makePeer(`p${i}`));
      const result = election.elect(peers, 50);
      // ceil(50/10) = 5
      expect(result.superNodes.length).toBe(5);
    });
  });

  describe('getMaxConnections()', () => {
    it('should return 15 for super nodes', () => {
      const superNodes = ['a', 'b'];
      expect(election.getMaxConnections('a', superNodes)).toBe(SUPER_NODE_MAX_CONNECTIONS);
    });

    it('should return 5 for regular nodes', () => {
      const superNodes = ['a', 'b'];
      expect(election.getMaxConnections('c', superNodes)).toBe(REGULAR_NODE_MAX_CONNECTIONS);
    });
  });

  describe('isSuperNode()', () => {
    it('should correctly identify super nodes', () => {
      const superNodes = ['a', 'b'];
      expect(election.isSuperNode('a', superNodes)).toBe(true);
      expect(election.isSuperNode('c', superNodes)).toBe(false);
    });
  });
});
