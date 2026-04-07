/**
 * Time-bucketed 去重快取
 * 替代無上限的 Set<string>，自動 evict 過期 bucket 以防止記憶體洩漏
 */
export class TimeBucketedCache {
  /** bucket duration in ms (default 60s) */
  private readonly bucketDurationMs: number;
  /** max number of buckets to retain */
  private readonly maxBuckets: number;
  /** Map from bucket index → Set of ids */
  private buckets: Map<number, Set<string>> = new Map();

  constructor(
    bucketDurationMs = 60_000,
    maxBuckets = 10
  ) {
    this.bucketDurationMs = bucketDurationMs;
    this.maxBuckets = maxBuckets;
  }

  /** Compute bucket index for a given timestamp */
  private getBucketIndex(now: number): number {
    return Math.floor(now / this.bucketDurationMs);
  }

  /** Add an id to the current bucket, evicting expired buckets */
  add(id: string): void {
    const now = Date.now();
    const bucketIdx = this.getBucketIndex(now);

    let bucket = this.buckets.get(bucketIdx);
    if (!bucket) {
      bucket = new Set();
      this.buckets.set(bucketIdx, bucket);
    }
    bucket.add(id);

    this.evict(bucketIdx);
  }

  /** Check if an id exists in any active bucket */
  has(id: string): boolean {
    const now = Date.now();
    const currentIdx = this.getBucketIndex(now);
    const minIdx = currentIdx - this.maxBuckets + 1;

    for (const [idx, bucket] of this.buckets) {
      if (idx < minIdx) continue;
      if (bucket.has(id)) return true;
    }
    return false;
  }

  /** Total number of entries across all active buckets */
  get size(): number {
    const now = Date.now();
    const currentIdx = this.getBucketIndex(now);
    const minIdx = currentIdx - this.maxBuckets + 1;

    let total = 0;
    for (const [idx, bucket] of this.buckets) {
      if (idx >= minIdx) {
        total += bucket.size;
      }
    }
    return total;
  }

  /** Remove buckets older than maxBuckets from current */
  private evict(currentBucketIdx: number): void {
    const minIdx = currentBucketIdx - this.maxBuckets + 1;
    for (const idx of this.buckets.keys()) {
      if (idx < minIdx) {
        this.buckets.delete(idx);
      }
    }
  }

  /** Clear all buckets */
  clear(): void {
    this.buckets.clear();
  }
}
