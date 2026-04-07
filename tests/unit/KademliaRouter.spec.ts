import { describe, it, expect, beforeEach } from 'vitest';
import {
  KademliaRouter,
  xorDistance,
  compareDistance,
  bucketIndex,
} from '../../src/core/relay/KademliaRouter';

describe('KademliaRouter', () => {
  describe('xorDistance', () => {
    it('returns zero for identical IDs', () => {
      const dist = xorDistance('abcd', 'abcd');
      expect(dist).toBe('0000');
    });

    it('computes correct XOR', () => {
      const dist = xorDistance('ff', '00');
      expect(dist).toBe('ff');
    });

    it('is symmetric', () => {
      const a = 'a1b2c3d4';
      const b = '11223344';
      expect(xorDistance(a, b)).toBe(xorDistance(b, a));
    });
  });

  describe('compareDistance', () => {
    it('returns 0 for equal distances', () => {
      expect(compareDistance('abcd', 'abcd')).toBe(0);
    });

    it('returns negative for smaller distance', () => {
      expect(compareDistance('0001', '0002')).toBeLessThan(0);
    });

    it('returns positive for larger distance', () => {
      expect(compareDistance('ffff', '0001')).toBeGreaterThan(0);
    });
  });

  describe('routing table', () => {
    let router: KademliaRouter;

    beforeEach(() => {
      router = new KademliaRouter('aa'.repeat(16));
    });

    it('adds and retrieves a node', () => {
      router.addNode({
        nodeId: 'bb'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: true,
        natType: 'open',
      });

      const node = router.getNode('bb'.repeat(16));
      expect(node).toBeDefined();
      expect(node!.latency).toBe(50);
    });

    it('does not add self', () => {
      const added = router.addNode({
        nodeId: 'aa'.repeat(16),
        lastSeen: Date.now(),
        latency: 0,
        isRelayCapable: true,
        natType: 'open',
      });
      expect(added).toBe(false);
    });

    it('removes a node', () => {
      router.addNode({
        nodeId: 'bb'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: true,
        natType: 'open',
      });
      expect(router.removeNode('bb'.repeat(16))).toBe(true);
      expect(router.getNode('bb'.repeat(16))).toBeUndefined();
    });

    it('finds closest nodes', () => {
      const nodes = ['11', '22', '33', '44', '55'].map((prefix) =>
        prefix.repeat(16)
      );

      for (const nodeId of nodes) {
        router.addNode({
          nodeId,
          lastSeen: Date.now(),
          latency: 50,
          isRelayCapable: true,
          natType: 'open',
        });
      }

      // Target close to 'aa' (our local ID)
      const closest = router.findClosest('ab'.repeat(16), 3);
      expect(closest.length).toBeLessThanOrEqual(3);
      expect(closest.length).toBeGreaterThan(0);
    });

    it('finds relay-capable nodes', () => {
      router.addNode({
        nodeId: 'bb'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: true,
        natType: 'open',
      });
      router.addNode({
        nodeId: 'cc'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: false,
        natType: 'open',
      });
      router.addNode({
        nodeId: 'dd'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: true,
        natType: 'symmetric', // Cannot relay
      });

      const relays = router.findRelayNodes();
      expect(relays).toHaveLength(1);
      expect(relays[0].nodeId).toBe('bb'.repeat(16));
    });

    it('counts nodes correctly', () => {
      expect(router.getNodeCount()).toBe(0);
      router.addNode({
        nodeId: 'bb'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: true,
        natType: 'open',
      });
      expect(router.getNodeCount()).toBe(1);
    });
  });

  describe('selectDiverseRelays', () => {
    let router: KademliaRouter;

    beforeEach(() => {
      router = new KademliaRouter('00'.repeat(16));
      // Add a variety of relay-capable nodes
      for (let i = 1; i <= 10; i++) {
        const hex = i.toString(16).padStart(2, '0');
        router.addNode({
          nodeId: hex.repeat(16),
          lastSeen: Date.now(),
          latency: 50 + i * 10,
          isRelayCapable: true,
          natType: 'open',
        });
      }
    });

    it('selects the requested number of diverse relays', () => {
      const selected = router.selectDiverseRelays(3);
      expect(selected).toHaveLength(3);
    });

    it('excludes specified nodes', () => {
      const excluded = '01'.repeat(16);
      const selected = router.selectDiverseRelays(3, [excluded]);
      expect(selected.every((n) => n.nodeId !== excluded)).toBe(true);
    });

    it('returns all available if fewer than requested', () => {
      const smallRouter = new KademliaRouter('00'.repeat(16));
      smallRouter.addNode({
        nodeId: '01'.repeat(16),
        lastSeen: Date.now(),
        latency: 50,
        isRelayCapable: true,
        natType: 'open',
      });
      const selected = smallRouter.selectDiverseRelays(5);
      expect(selected).toHaveLength(1);
    });
  });
});
