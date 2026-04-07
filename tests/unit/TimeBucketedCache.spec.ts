import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeBucketedCache } from '../../src/core/mesh/TimeBucketedCache';

describe('TimeBucketedCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should add and check existence', () => {
    const cache = new TimeBucketedCache(60_000, 10);
    cache.add('msg-1');
    expect(cache.has('msg-1')).toBe(true);
    expect(cache.has('msg-2')).toBe(false);
  });

  it('should report correct size', () => {
    const cache = new TimeBucketedCache(60_000, 10);
    cache.add('a');
    cache.add('b');
    cache.add('c');
    expect(cache.size).toBe(3);
  });

  it('should not duplicate entries in the same bucket', () => {
    const cache = new TimeBucketedCache(60_000, 10);
    cache.add('dup');
    cache.add('dup');
    expect(cache.size).toBe(1);
  });

  it('should evict expired buckets', () => {
    // 2 buckets of 1 second each → keeps only last 2 seconds
    const cache = new TimeBucketedCache(1_000, 2);

    cache.add('early');
    expect(cache.has('early')).toBe(true);

    // Advance 3 seconds → 'early' is in bucket 0, current bucket is 3 → evicted
    vi.advanceTimersByTime(3_000);
    cache.add('late'); // triggers eviction
    expect(cache.has('early')).toBe(false);
    expect(cache.has('late')).toBe(true);
  });

  it('should respect maxBuckets limit', () => {
    const cache = new TimeBucketedCache(1_000, 3);

    // Add items across 5 different buckets (0s, 1s, 2s, 3s, 4s)
    cache.add('t0');
    vi.advanceTimersByTime(1_000);
    cache.add('t1');
    vi.advanceTimersByTime(1_000);
    cache.add('t2');
    vi.advanceTimersByTime(1_000);
    cache.add('t3');
    vi.advanceTimersByTime(1_000);
    cache.add('t4');

    // maxBuckets=3 → only buckets 2,3,4 active → t0,t1 evicted
    expect(cache.has('t0')).toBe(false);
    expect(cache.has('t1')).toBe(false);
    expect(cache.has('t2')).toBe(true);
    expect(cache.has('t3')).toBe(true);
    expect(cache.has('t4')).toBe(true);
  });

  it('should handle high-frequency writes without memory leak', () => {
    // Small buckets to force eviction
    const cache = new TimeBucketedCache(100, 3); // 100ms buckets, keep 3

    for (let i = 0; i < 10_000; i++) {
      cache.add(`msg-${i}`);
      if (i % 100 === 0) {
        vi.advanceTimersByTime(100); // new bucket every 100 writes
      }
    }

    // Size should be bounded by ~3 buckets worth, not 10,000
    expect(cache.size).toBeLessThan(5_000);
    // Recent messages should be findable
    expect(cache.has('msg-9999')).toBe(true);
    // Very old messages should be evicted
    expect(cache.has('msg-0')).toBe(false);
  });

  it('should clear all buckets', () => {
    const cache = new TimeBucketedCache(60_000, 10);
    cache.add('a');
    cache.add('b');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });

  it('has() should not return true for items in evicted buckets even without add()', () => {
    const cache = new TimeBucketedCache(1_000, 2);
    cache.add('old');
    vi.advanceTimersByTime(5_000);
    // has() checks against minIdx, so old bucket should be excluded
    expect(cache.has('old')).toBe(false);
  });
});
