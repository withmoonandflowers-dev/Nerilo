/**
 * Causal Ordering Buffer
 *
 * Ensures messages are delivered in causal order by holding back messages
 * whose dependencies (deps) have not yet been delivered.
 *
 * - If all deps are satisfied → deliver immediately
 * - If deps are missing → buffer and deliver once deps arrive
 * - Timeout: messages buffered > 5s are force-delivered (marked as possibly out-of-order)
 */

import type { CausalMessage } from '../../types';
import { TimeBucketedCache } from '../mesh/TimeBucketedCache';

/** Force-deliver timeout in ms */
const FORCE_DELIVER_TIMEOUT_MS = 5_000;

export interface BufferedMessage {
  message: CausalMessage;
  missingDeps: Set<string>;
  bufferedAt: number;
}

export type DeliverCallback = (message: CausalMessage, forced: boolean) => void;

export class CausalOrderingBuffer {
  /** Set of delivered message IDs (uses time-bucketed cache for bounded memory) */
  private deliveredSet: TimeBucketedCache;
  /** Pending messages waiting for deps */
  private pendingBuffer = new Map<string, BufferedMessage>();
  /** Timer for checking forced delivery */
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  /** Delivery callback */
  private deliverCallback: DeliverCallback | null = null;

  constructor() {
    // Reuse TimeBucketedCache: 1-minute buckets, keep last 10 minutes
    this.deliveredSet = new TimeBucketedCache(60_000, 10);
  }

  /**
   * Set the callback for when a message is ready to be delivered.
   */
  onDeliver(callback: DeliverCallback): void {
    this.deliverCallback = callback;
  }

  /**
   * Process an incoming message. Either delivers it immediately or buffers it.
   */
  receive(message: CausalMessage): void {
    const { messageId, deps } = message;

    // Already delivered? Skip.
    if (this.deliveredSet.has(messageId)) return;

    // Check which deps are missing
    const missingDeps = new Set<string>();
    if (deps && deps.length > 0) {
      for (const dep of deps) {
        if (!this.deliveredSet.has(dep)) {
          missingDeps.add(dep);
        }
      }
    }

    if (missingDeps.size === 0) {
      // All deps satisfied → deliver
      this.deliver(message, false);
    } else {
      // Buffer until deps are satisfied
      this.pendingBuffer.set(messageId, {
        message,
        missingDeps,
        bufferedAt: Date.now(),
      });
      this.ensureCheckTimer();
    }
  }

  /**
   * Deliver a message and check if any pending messages can now be delivered.
   */
  private deliver(message: CausalMessage, forced: boolean): void {
    this.deliveredSet.add(message.messageId);
    this.pendingBuffer.delete(message.messageId);

    if (this.deliverCallback) {
      this.deliverCallback(message, forced);
    }

    // Check if any pending messages now have all deps satisfied
    this.checkPendingBuffer();
  }

  /**
   * Scan pending buffer for messages whose deps are now all satisfied.
   */
  private checkPendingBuffer(): void {
    const toDeliver: CausalMessage[] = [];

    for (const [_messageId, entry] of this.pendingBuffer) {
      // Remove any deps that have since been delivered
      for (const dep of entry.missingDeps) {
        if (this.deliveredSet.has(dep)) {
          entry.missingDeps.delete(dep);
        }
      }

      if (entry.missingDeps.size === 0) {
        toDeliver.push(entry.message);
      }
    }

    // Deliver in order (by timestamp as a simple heuristic)
    toDeliver.sort((a, b) => a.timestamp - b.timestamp);
    for (const msg of toDeliver) {
      this.deliver(msg, false);
    }
  }

  /**
   * Check for messages that have been buffered too long and force-deliver them.
   */
  private checkTimeouts(): void {
    const now = Date.now();
    const toForceDeliver: CausalMessage[] = [];

    for (const [, entry] of this.pendingBuffer) {
      if (now - entry.bufferedAt > FORCE_DELIVER_TIMEOUT_MS) {
        toForceDeliver.push(entry.message);
      }
    }

    // Sort force-delivered messages by timestamp
    toForceDeliver.sort((a, b) => a.timestamp - b.timestamp);
    for (const msg of toForceDeliver) {
      this.deliver(msg, true);
    }

    // Stop timer if buffer is empty
    if (this.pendingBuffer.size === 0 && this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Start the timeout check timer if not already running.
   */
  private ensureCheckTimer(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      this.checkTimeouts();
    }, 1_000);
  }

  /**
   * Get the number of messages currently buffered.
   */
  get pendingCount(): number {
    return this.pendingBuffer.size;
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.pendingBuffer.clear();
    this.deliveredSet.clear();
  }
}
