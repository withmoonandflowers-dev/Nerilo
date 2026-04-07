/**
 * RateLimiter — Sliding window rate limiting for relay nodes
 *
 * Prevents spam and flooding by limiting the number of messages
 * each peer can relay within a configurable time window.
 *
 * Features:
 * - Per-peer sliding window counters
 * - Configurable penalty duration for violators
 * - Auto-cleanup of stale entries
 * - Global rate limit for total relay throughput
 */

import type { RateLimitConfig, RateLimitStatus } from './types';

const DEFAULT_CONFIG: RateLimitConfig = {
  maxMessages: 100,
  windowMs: 600_000, // 10 minutes
  penaltyMs: 60_000, // 1 minute block
};

/** Global rate limit: max total relay messages across all peers */
const DEFAULT_GLOBAL_MAX = 1000;

/** Cleanup interval for stale entries */
const CLEANUP_INTERVAL_MS = 120_000; // 2 minutes

export class RateLimiter {
  private peerWindows = new Map<string, number[]>(); // nodeId → timestamps
  private penalties = new Map<string, number>(); // nodeId → penalty expires at
  private config: RateLimitConfig;
  private globalMax: number;
  private globalWindow: number[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<RateLimitConfig> = {}, globalMax = DEFAULT_GLOBAL_MAX) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.globalMax = globalMax;
  }

  /** Start periodic cleanup */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** Stop cleanup timer */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Check if a message from this peer should be allowed.
   * Returns true if allowed, false if rate-limited.
   * Automatically records the message if allowed.
   */
  tryConsume(nodeId: string): boolean {
    const now = Date.now();

    // Check if peer is in penalty
    const penaltyExpires = this.penalties.get(nodeId);
    if (penaltyExpires && now < penaltyExpires) {
      return false;
    }
    if (penaltyExpires && now >= penaltyExpires) {
      this.penalties.delete(nodeId);
    }

    // Check global rate limit
    this.pruneWindow(this.globalWindow, now);
    if (this.globalWindow.length >= this.globalMax) {
      return false;
    }

    // Check per-peer rate limit
    let window = this.peerWindows.get(nodeId);
    if (!window) {
      window = [];
      this.peerWindows.set(nodeId, window);
    }
    this.pruneWindow(window, now);

    if (window.length >= this.config.maxMessages) {
      // Apply penalty
      this.penalties.set(nodeId, now + this.config.penaltyMs);
      return false;
    }

    // Record message
    window.push(now);
    this.globalWindow.push(now);
    return true;
  }

  /** Check rate limit status without consuming */
  getStatus(nodeId: string): RateLimitStatus {
    const now = Date.now();

    const penaltyExpires = this.penalties.get(nodeId) ?? 0;
    const isLimited = penaltyExpires > now;

    let window = this.peerWindows.get(nodeId);
    if (!window) {
      window = [];
    }
    this.pruneWindow(window, now);

    return {
      nodeId,
      messageCount: window.length,
      windowStart: now - this.config.windowMs,
      isLimited,
      limitExpiresAt: isLimited ? penaltyExpires : 0,
    };
  }

  /** Get remaining quota for a peer */
  getRemainingQuota(nodeId: string): number {
    const now = Date.now();
    const window = this.peerWindows.get(nodeId);
    if (!window) return this.config.maxMessages;
    this.pruneWindow(window, now);
    return Math.max(0, this.config.maxMessages - window.length);
  }

  /** Manually block a peer for a duration */
  penalize(nodeId: string, durationMs?: number): void {
    const duration = durationMs ?? this.config.penaltyMs;
    this.penalties.set(nodeId, Date.now() + duration);
  }

  /** Remove a peer's rate limit data */
  removePeer(nodeId: string): void {
    this.peerWindows.delete(nodeId);
    this.penalties.delete(nodeId);
  }

  /** Get the current config */
  getConfig(): RateLimitConfig {
    return { ...this.config };
  }

  /** Update rate limit config */
  updateConfig(config: Partial<RateLimitConfig>): void {
    Object.assign(this.config, config);
  }

  /** Get global throughput in the current window */
  getGlobalThroughput(): number {
    this.pruneWindow(this.globalWindow, Date.now());
    return this.globalWindow.length;
  }

  /** Clean up */
  destroy(): void {
    this.stop();
    this.peerWindows.clear();
    this.penalties.clear();
    this.globalWindow.length = 0;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Remove timestamps outside the current window */
  private pruneWindow(window: number[], now: number): void {
    const cutoff = now - this.config.windowMs;
    // Find first index within window (timestamps are sorted)
    let i = 0;
    while (i < window.length && window[i] < cutoff) {
      i++;
    }
    if (i > 0) {
      window.splice(0, i);
    }
  }

  /** Periodic cleanup of stale peer entries */
  private cleanup(): void {
    const now = Date.now();

    // Clean expired penalties
    for (const [nodeId, expiresAt] of this.penalties) {
      if (now >= expiresAt) {
        this.penalties.delete(nodeId);
      }
    }

    // Clean empty peer windows
    for (const [nodeId, window] of this.peerWindows) {
      this.pruneWindow(window, now);
      if (window.length === 0) {
        this.peerWindows.delete(nodeId);
      }
    }

    // Prune global window
    this.pruneWindow(this.globalWindow, now);
  }
}
