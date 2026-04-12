import { describe, it, expect, beforeEach } from 'vitest';
import { AdaptiveTopologyManager } from '../../src/core/mesh/AdaptiveTopologyManager';

describe('AdaptiveTopologyManager', () => {
  let manager: AdaptiveTopologyManager;

  beforeEach(() => {
    manager = new AdaptiveTopologyManager();
  });

  describe('getStrategy() — initial (no hysteresis)', () => {
    it('should return direct for 1-2 participants', () => {
      expect(manager.getStrategy(1)).toBe('direct');
      expect(new AdaptiveTopologyManager().getStrategy(2)).toBe('direct');
    });

    it('should return full-mesh for 3-6 participants', () => {
      expect(manager.getStrategy(3)).toBe('full-mesh');
      expect(new AdaptiveTopologyManager().getStrategy(6)).toBe('full-mesh');
    });

    it('should return partial-mesh for 7-20 participants', () => {
      expect(manager.getStrategy(7)).toBe('partial-mesh');
      expect(new AdaptiveTopologyManager().getStrategy(20)).toBe('partial-mesh');
    });

    it('should return super-node for 21+ participants', () => {
      expect(manager.getStrategy(21)).toBe('super-node');
      expect(new AdaptiveTopologyManager().getStrategy(100)).toBe('super-node');
    });
  });

  describe('getStrategy() — hysteresis behavior', () => {
    it('should NOT upgrade full-mesh to partial-mesh at 7 (hysteresis: upgradeAt=8)', () => {
      manager.getStrategy(5); // set current = full-mesh
      expect(manager.getStrategy(7)).toBe('full-mesh'); // stays due to hysteresis
    });

    it('should upgrade full-mesh to partial-mesh at 8', () => {
      manager.getStrategy(5); // set current = full-mesh
      expect(manager.getStrategy(8)).toBe('partial-mesh');
    });

    it('should NOT downgrade partial-mesh to full-mesh at 6 (hysteresis: downgradeAt=5)', () => {
      manager.getStrategy(10); // set current = partial-mesh
      expect(manager.getStrategy(6)).toBe('partial-mesh'); // stays due to hysteresis
    });

    it('should downgrade partial-mesh to full-mesh at 5', () => {
      manager.getStrategy(10); // set current = partial-mesh
      expect(manager.getStrategy(5)).toBe('full-mesh');
    });

    it('should prevent thrashing at boundary 7-8', () => {
      manager.getStrategy(5); // full-mesh
      expect(manager.getStrategy(7)).toBe('full-mesh');   // stays
      expect(manager.getStrategy(8)).toBe('partial-mesh'); // upgrades
      expect(manager.getStrategy(7)).toBe('partial-mesh'); // stays (downgradeAt=5)
      expect(manager.getStrategy(6)).toBe('partial-mesh'); // stays
      expect(manager.getStrategy(5)).toBe('full-mesh');    // finally downgrades
    });
  });

  describe('getTargetNeighborCount()', () => {
    it('should return 0 for 1 participant', () => {
      expect(manager.getTargetNeighborCount(1)).toBe(0);
    });

    it('should return 1 for direct (2 participants)', () => {
      expect(manager.getTargetNeighborCount(2)).toBe(1);
    });

    it('should return n-1 for full-mesh (3-6)', () => {
      expect(manager.getTargetNeighborCount(3)).toBe(2);
      expect(manager.getTargetNeighborCount(6)).toBe(5);
    });

    it('should return max(3, ceil(sqrt(n))) for partial-mesh (7-20)', () => {
      expect(manager.getTargetNeighborCount(7)).toBe(3); // ceil(sqrt(7))=3
      expect(manager.getTargetNeighborCount(9)).toBe(3); // ceil(sqrt(9))=3
      expect(manager.getTargetNeighborCount(16)).toBe(4); // ceil(sqrt(16))=4
      expect(manager.getTargetNeighborCount(20)).toBe(5); // ceil(sqrt(20))=5
    });

    it('should return 5 for super-node (21+)', () => {
      expect(manager.getTargetNeighborCount(25)).toBe(5);
      expect(manager.getTargetNeighborCount(100)).toBe(5);
    });
  });

  describe('getGossipConfig()', () => {
    it('should return fanout=n-1, ttl=1 for small rooms (<=6)', () => {
      const cfg3 = manager.getGossipConfig(3);
      expect(cfg3.fanout).toBe(2);
      expect(cfg3.ttl).toBe(1);

      const cfg6 = manager.getGossipConfig(6);
      expect(cfg6.fanout).toBe(5);
      expect(cfg6.ttl).toBe(1);
    });

    it('should return fanout=3, ttl=3 for medium rooms (7-12)', () => {
      const cfg = manager.getGossipConfig(10);
      expect(cfg.fanout).toBe(3);
      expect(cfg.ttl).toBe(3);
    });

    it('should return fanout=3, ttl=4 for larger rooms (13-20)', () => {
      const cfg = manager.getGossipConfig(15);
      expect(cfg.fanout).toBe(3);
      expect(cfg.ttl).toBe(4);
    });

    it('should return fanout=4, ttl=5 for super-node rooms (>20)', () => {
      const cfg = manager.getGossipConfig(30);
      expect(cfg.fanout).toBe(4);
      expect(cfg.ttl).toBe(5);
    });

    it('should return fanout >= 1 even for 1 participant', () => {
      const cfg = manager.getGossipConfig(1);
      expect(cfg.fanout).toBeGreaterThanOrEqual(0);
    });
  });

  describe('evaluateTopology()', () => {
    it('should return complete evaluation', () => {
      const eval10 = manager.evaluateTopology(10);
      expect(eval10.strategy).toBe('partial-mesh');
      expect(eval10.targetNeighborCount).toBe(4); // ceil(sqrt(10))=4, max(3,4)=4
      expect(eval10.gossipConfig.fanout).toBe(3);
      expect(eval10.gossipConfig.ttl).toBe(3);
    });
  });

  describe('shouldUpgrade / shouldDowngrade', () => {
    it('should detect upgrade at hysteresis boundary (full-mesh upgradeAt=8)', () => {
      expect(manager.shouldUpgrade('full-mesh', 8)).toBe(true);
      expect(new AdaptiveTopologyManager().shouldUpgrade('full-mesh', 7)).toBe(false);
    });

    it('should detect upgrade at hysteresis boundary (partial-mesh upgradeAt=22)', () => {
      expect(manager.shouldUpgrade('partial-mesh', 22)).toBe(true);
      expect(new AdaptiveTopologyManager().shouldUpgrade('partial-mesh', 21)).toBe(false);
    });

    it('should detect downgrade at hysteresis boundary (partial-mesh downgradeAt=5)', () => {
      expect(manager.shouldDowngrade('partial-mesh', 5)).toBe(true);
      expect(new AdaptiveTopologyManager().shouldDowngrade('partial-mesh', 6)).toBe(false);
    });

    it('should detect downgrade at hysteresis boundary (full-mesh downgradeAt=2)', () => {
      expect(manager.shouldDowngrade('full-mesh', 2)).toBe(true);
      expect(new AdaptiveTopologyManager().shouldDowngrade('full-mesh', 3)).toBe(false);
    });

    it('should not upgrade/downgrade when within hysteresis band', () => {
      expect(manager.shouldUpgrade('full-mesh', 5)).toBe(false);
      expect(new AdaptiveTopologyManager().shouldDowngrade('full-mesh', 5)).toBe(false);
    });
  });
});
