/**
 * GossipAckManager — ACK-based reliable delivery for critical gossip messages
 *
 * Non-critical chat messages use best-effort gossip (fire-and-forget).
 * Critical messages (key rotation, membership changes, governance votes)
 * require acknowledgment to ensure delivery.
 *
 * Strategy:
 * - Sender assigns a unique ackId to critical messages
 * - Each recipient sends back an ACK envelope
 * - If ACK is not received within timeout, message is retried
 * - Exponential backoff: 2s → 4s → 8s (max 3 retries by default)
 * - After max retries, fires an onFailure callback
 */

import { logger } from '../../utils/logger';

export interface AckConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial timeout in ms before first retry (default: 2000) */
  baseTimeoutMs: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Maximum timeout cap in ms (default: 15000) */
  maxTimeoutMs: number;
  /** Maximum pending ACK entries before eviction (default: 500) */
  maxPendingEntries: number;
}

const DEFAULT_ACK_CONFIG: AckConfig = {
  maxRetries: 3,
  baseTimeoutMs: 2_000,
  backoffMultiplier: 2,
  maxTimeoutMs: 15_000,
  maxPendingEntries: 500,
};

/** Message types that require ACK */
export type CriticalMessageType =
  | 'key-rotation'
  | 'member-join'
  | 'member-leave'
  | 'member-kick'
  | 'governance-vote'
  | 'role-change'
  | 'channel-update';

export interface PendingAck {
  ackId: string;
  messageType: CriticalMessageType;
  /** Set of peer IDs we expect ACKs from */
  expectedPeers: Set<string>;
  /** Set of peer IDs that have ACKed */
  ackedPeers: Set<string>;
  /** Current retry attempt (0 = first send) */
  retryCount: number;
  /** Timestamp of initial send */
  sentAt: number;
  /** Timer handle for retry scheduling */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** The resend function to invoke on retry */
  resend: () => Promise<void>;
}

/** ACK envelope sent back by recipients */
export interface AckEnvelope {
  type: 'gossip:ack';
  ackId: string;
  senderId: string;
}

export type AckFailureHandler = (
  ackId: string,
  messageType: CriticalMessageType,
  missingPeers: string[]
) => void;

export type AckSuccessHandler = (
  ackId: string,
  messageType: CriticalMessageType
) => void;

export class GossipAckManager {
  private pending = new Map<string, PendingAck>();
  private config: AckConfig;
  private failureHandlers = new Set<AckFailureHandler>();
  private successHandlers = new Set<AckSuccessHandler>();
  private ackCounter = 0;

  constructor(
    private readonly localId: string,
    config?: Partial<AckConfig>
  ) {
    this.config = { ...DEFAULT_ACK_CONFIG, ...config };
  }

  /**
   * Register a critical message that requires ACK from specified peers.
   * Returns the ackId to embed in the outgoing message.
   */
  trackMessage(
    messageType: CriticalMessageType,
    expectedPeers: string[],
    resend: () => Promise<void>
  ): string {
    const ackId = `${this.localId}:ack:${Date.now()}:${++this.ackCounter}`;

    // Evict oldest if over limit
    if (this.pending.size >= this.config.maxPendingEntries) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.cancelEntry(oldest);
      }
    }

    const entry: PendingAck = {
      ackId,
      messageType,
      expectedPeers: new Set(expectedPeers),
      ackedPeers: new Set(),
      retryCount: 0,
      sentAt: Date.now(),
      retryTimer: null,
      resend,
    };

    this.pending.set(ackId, entry);
    this.scheduleRetry(entry);

    return ackId;
  }

  /**
   * Process an incoming ACK from a peer.
   */
  handleAck(ack: AckEnvelope): void {
    const entry = this.pending.get(ack.ackId);
    if (!entry) return; // Already completed or unknown

    entry.ackedPeers.add(ack.senderId);

    // Check if all expected peers have ACKed
    if (this.isFullyAcked(entry)) {
      this.cancelEntry(ack.ackId);
      logger.info('[GossipAckManager] All ACKs received', {
        ackId: ack.ackId,
        messageType: entry.messageType,
      });
      this.notifySuccess(entry.ackId, entry.messageType);
    }
  }

  /**
   * Create an ACK envelope to send back to the originator.
   */
  createAck(ackId: string): AckEnvelope {
    return {
      type: 'gossip:ack',
      ackId,
      senderId: this.localId,
    };
  }

  /** Register a failure handler */
  onFailure(handler: AckFailureHandler): () => void {
    this.failureHandlers.add(handler);
    return () => { this.failureHandlers.delete(handler); };
  }

  /** Register a success handler */
  onSuccess(handler: AckSuccessHandler): () => void {
    this.successHandlers.add(handler);
    return () => { this.successHandlers.delete(handler); };
  }

  /** Get count of pending ACK entries */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** Get missing peers for a specific ackId */
  getMissingPeers(ackId: string): string[] {
    const entry = this.pending.get(ackId);
    if (!entry) return [];
    return [...entry.expectedPeers].filter(p => !entry.ackedPeers.has(p));
  }

  /** Remove a peer from all pending entries (e.g. when peer disconnects) */
  removePeer(peerId: string): void {
    for (const [ackId, entry] of this.pending) {
      entry.expectedPeers.delete(peerId);
      if (this.isFullyAcked(entry)) {
        this.cancelEntry(ackId);
        this.notifySuccess(entry.ackId, entry.messageType);
      }
    }
  }

  /** Clean up all pending entries */
  destroy(): void {
    for (const ackId of [...this.pending.keys()]) {
      this.cancelEntry(ackId);
    }
    this.failureHandlers.clear();
    this.successHandlers.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private isFullyAcked(entry: PendingAck): boolean {
    for (const peer of entry.expectedPeers) {
      if (!entry.ackedPeers.has(peer)) return false;
    }
    return true;
  }

  private scheduleRetry(entry: PendingAck): void {
    const timeout = this.getRetryTimeout(entry.retryCount);

    entry.retryTimer = setTimeout(async () => {
      entry.retryTimer = null;

      if (!this.pending.has(entry.ackId)) return; // Already completed

      if (entry.retryCount >= this.config.maxRetries) {
        // Max retries reached — report failure
        const missing = this.getMissingPeers(entry.ackId);
        logger.warn('[GossipAckManager] ACK timeout, max retries reached', {
          ackId: entry.ackId,
          messageType: entry.messageType,
          missingPeers: missing,
          retries: entry.retryCount,
        });
        this.cancelEntry(entry.ackId);
        this.notifyFailure(entry.ackId, entry.messageType, missing);
        return;
      }

      // Retry
      entry.retryCount++;
      logger.info('[GossipAckManager] Retrying critical message', {
        ackId: entry.ackId,
        messageType: entry.messageType,
        attempt: entry.retryCount,
        missingPeers: this.getMissingPeers(entry.ackId),
      });

      try {
        await entry.resend();
      } catch (err) {
        logger.warn('[GossipAckManager] Resend failed', {
          ackId: entry.ackId,
          err,
        });
      }

      // Schedule next retry
      if (this.pending.has(entry.ackId)) {
        this.scheduleRetry(entry);
      }
    }, timeout);
  }

  private getRetryTimeout(retryCount: number): number {
    const { baseTimeoutMs, backoffMultiplier, maxTimeoutMs } = this.config;
    const timeout = baseTimeoutMs * Math.pow(backoffMultiplier, retryCount);
    return Math.min(timeout, maxTimeoutMs);
  }

  private cancelEntry(ackId: string): void {
    const entry = this.pending.get(ackId);
    if (entry?.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    this.pending.delete(ackId);
  }

  private notifyFailure(ackId: string, messageType: CriticalMessageType, missingPeers: string[]): void {
    for (const handler of this.failureHandlers) {
      try { handler(ackId, messageType, missingPeers); } catch { /* ignore */ }
    }
  }

  private notifySuccess(ackId: string, messageType: CriticalMessageType): void {
    for (const handler of this.successHandlers) {
      try { handler(ackId, messageType); } catch { /* ignore */ }
    }
  }
}
