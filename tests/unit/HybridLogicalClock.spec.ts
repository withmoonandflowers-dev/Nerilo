import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HybridLogicalClock, type HLCTimestamp } from '../../src/core/clock/HybridLogicalClock';

describe('HybridLogicalClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('now()', () => {
    it('should generate monotonically increasing timestamps', () => {
      const clock = new HybridLogicalClock('node-a');

      const t1 = clock.now();
      const t2 = clock.now();
      const t3 = clock.now();

      expect(HybridLogicalClock.compare(t1, t2)).toBeLessThan(0);
      expect(HybridLogicalClock.compare(t2, t3)).toBeLessThan(0);
    });

    it('should increment logical counter when wall time is unchanged', () => {
      const clock = new HybridLogicalClock('node-a');

      const t1 = clock.now();
      const t2 = clock.now();

      expect(t1.wallTime).toBe(t2.wallTime);
      expect(t2.logical).toBe(t1.logical + 1);
    });

    it('should reset logical counter when wall time advances', () => {
      const clock = new HybridLogicalClock('node-a');

      clock.now();
      vi.advanceTimersByTime(1);
      const t2 = clock.now();

      expect(t2.logical).toBe(0);
    });

    it('should include the correct nodeId', () => {
      const clock = new HybridLogicalClock('abcdef12');
      const ts = clock.now();
      expect(ts.nodeId).toBe('abcdef12');
    });
  });

  describe('receive()', () => {
    it('should merge correctly when remote is ahead', () => {
      const clock = new HybridLogicalClock('node-b');

      const remote: HLCTimestamp = {
        wallTime: Date.now() + 5_000,
        logical: 3,
        nodeId: 'node-a',
      };

      const merged = clock.receive(remote);
      expect(merged.wallTime).toBe(remote.wallTime);
      expect(merged.logical).toBe(remote.logical + 1);
      expect(merged.nodeId).toBe('node-b');
    });

    it('should use local physical time when it is ahead of both', () => {
      const clock = new HybridLogicalClock('node-b');

      const remote: HLCTimestamp = {
        wallTime: Date.now() - 5_000,
        logical: 10,
        nodeId: 'node-a',
      };

      const merged = clock.receive(remote);
      expect(merged.wallTime).toBe(Date.now());
      expect(merged.logical).toBe(0);
    });

    it('should take max logical + 1 when wall times are equal', () => {
      const clock = new HybridLogicalClock('node-b');
      // First, set internal wallTime to current
      clock.now();

      const remote: HLCTimestamp = {
        wallTime: Date.now(),
        logical: 5,
        nodeId: 'node-a',
      };

      const merged = clock.receive(remote);
      // logical should be max(local_logical, remote_logical) + 1
      expect(merged.logical).toBe(6);
    });

    it('should handle clock drift gracefully (remote far in future)', () => {
      const clock = new HybridLogicalClock('node-b');

      const remote: HLCTimestamp = {
        wallTime: Date.now() + 120_000, // 2 min in future
        logical: 0,
        nodeId: 'node-a',
      };

      // Should not throw, should merge
      const merged = clock.receive(remote);
      expect(merged.wallTime).toBeGreaterThanOrEqual(Date.now());
    });

    it('should maintain monotonicity after receive', () => {
      const clock = new HybridLogicalClock('node-b');

      const t1 = clock.now();
      const remote: HLCTimestamp = {
        wallTime: Date.now() + 1_000,
        logical: 0,
        nodeId: 'node-a',
      };
      const t2 = clock.receive(remote);
      const t3 = clock.now();

      expect(HybridLogicalClock.compare(t1, t2)).toBeLessThan(0);
      expect(HybridLogicalClock.compare(t2, t3)).toBeLessThan(0);
    });
  });

  describe('compare()', () => {
    it('should order by wallTime first', () => {
      const a: HLCTimestamp = { wallTime: 100, logical: 5, nodeId: 'zzz' };
      const b: HLCTimestamp = { wallTime: 200, logical: 0, nodeId: 'aaa' };
      expect(HybridLogicalClock.compare(a, b)).toBeLessThan(0);
    });

    it('should order by logical when wallTime is equal', () => {
      const a: HLCTimestamp = { wallTime: 100, logical: 2, nodeId: 'zzz' };
      const b: HLCTimestamp = { wallTime: 100, logical: 5, nodeId: 'aaa' };
      expect(HybridLogicalClock.compare(a, b)).toBeLessThan(0);
    });

    it('should use nodeId as tiebreaker', () => {
      const a: HLCTimestamp = { wallTime: 100, logical: 5, nodeId: 'aaa' };
      const b: HLCTimestamp = { wallTime: 100, logical: 5, nodeId: 'bbb' };
      expect(HybridLogicalClock.compare(a, b)).toBeLessThan(0);
      expect(HybridLogicalClock.compare(b, a)).toBeGreaterThan(0);
    });

    it('should return 0 for identical timestamps', () => {
      const ts: HLCTimestamp = { wallTime: 100, logical: 5, nodeId: 'aaa' };
      expect(HybridLogicalClock.compare(ts, { ...ts })).toBe(0);
    });

    it('should provide total ordering (transitivity)', () => {
      const a: HLCTimestamp = { wallTime: 100, logical: 0, nodeId: 'a' };
      const b: HLCTimestamp = { wallTime: 100, logical: 1, nodeId: 'a' };
      const c: HLCTimestamp = { wallTime: 100, logical: 1, nodeId: 'b' };

      expect(HybridLogicalClock.compare(a, b)).toBeLessThan(0);
      expect(HybridLogicalClock.compare(b, c)).toBeLessThan(0);
      expect(HybridLogicalClock.compare(a, c)).toBeLessThan(0);
    });
  });

  describe('toString / fromString', () => {
    it('should roundtrip correctly', () => {
      const ts: HLCTimestamp = {
        wallTime: 1704067200000,
        logical: 42,
        nodeId: 'abcdef12',
      };

      const str = HybridLogicalClock.toString(ts);
      const parsed = HybridLogicalClock.fromString(str);

      expect(parsed.wallTime).toBe(ts.wallTime);
      expect(parsed.logical).toBe(ts.logical);
      expect(parsed.nodeId).toBe(ts.nodeId.slice(0, 8));
    });

    it('should produce expected string format', () => {
      const ts: HLCTimestamp = {
        wallTime: 1000,
        logical: 3,
        nodeId: 'node1234extra',
      };
      expect(HybridLogicalClock.toString(ts)).toBe('1000-3-node1234');
    });

    it('should throw on invalid string', () => {
      expect(() => HybridLogicalClock.fromString('invalid')).toThrow();
    });

    it('should handle nodeId with dashes', () => {
      const ts: HLCTimestamp = {
        wallTime: 1000,
        logical: 0,
        nodeId: 'ab-cd-ef',
      };
      const str = HybridLogicalClock.toString(ts);
      const parsed = HybridLogicalClock.fromString(str);
      expect(parsed.nodeId).toBe('ab-cd-ef');
    });
  });
});
