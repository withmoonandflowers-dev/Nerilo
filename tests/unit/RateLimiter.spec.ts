import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../src/core/relay/RateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      maxMessages: 5,
      windowMs: 10_000,
      penaltyMs: 5_000,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('basic rate limiting', () => {
    it('allows messages within the limit', () => {
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume('node-1')).toBe(true);
      }
    });

    it('blocks messages exceeding the limit', () => {
      for (let i = 0; i < 5; i++) limiter.tryConsume('node-1');
      expect(limiter.tryConsume('node-1')).toBe(false);
    });

    it('tracks per-peer independently', () => {
      for (let i = 0; i < 5; i++) limiter.tryConsume('node-1');
      expect(limiter.tryConsume('node-1')).toBe(false);
      expect(limiter.tryConsume('node-2')).toBe(true);
    });
  });

  describe('remaining quota', () => {
    it('returns full quota for new peer', () => {
      expect(limiter.getRemainingQuota('node-1')).toBe(5);
    });

    it('decreases quota as messages are consumed', () => {
      limiter.tryConsume('node-1');
      limiter.tryConsume('node-1');
      expect(limiter.getRemainingQuota('node-1')).toBe(3);
    });
  });

  describe('status', () => {
    it('reports not limited for new peer', () => {
      const status = limiter.getStatus('node-1');
      expect(status.isLimited).toBe(false);
      expect(status.messageCount).toBe(0);
    });

    it('reports limited after exceeding', () => {
      for (let i = 0; i < 6; i++) limiter.tryConsume('node-1');
      const status = limiter.getStatus('node-1');
      expect(status.isLimited).toBe(true);
      expect(status.limitExpiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('manual penalty', () => {
    it('blocks a peer with manual penalty', () => {
      limiter.penalize('node-1', 10_000);
      expect(limiter.tryConsume('node-1')).toBe(false);
    });
  });

  describe('peer removal', () => {
    it('clears rate limit data on removal', () => {
      for (let i = 0; i < 6; i++) limiter.tryConsume('node-1');
      limiter.removePeer('node-1');
      expect(limiter.tryConsume('node-1')).toBe(true);
    });
  });

  describe('global rate limit', () => {
    it('enforces global throughput limit', () => {
      const smallLimiter = new RateLimiter(
        { maxMessages: 100, windowMs: 10_000 },
        3 // global max = 3
      );
      expect(smallLimiter.tryConsume('node-1')).toBe(true);
      expect(smallLimiter.tryConsume('node-2')).toBe(true);
      expect(smallLimiter.tryConsume('node-3')).toBe(true);
      expect(smallLimiter.tryConsume('node-4')).toBe(false);
      smallLimiter.destroy();
    });
  });
});
