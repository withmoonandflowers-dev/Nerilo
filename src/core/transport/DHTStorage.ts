/**
 * DHTStorage — Kademlia DHT-Based Decentralized Message Storage
 *
 * Stores offline messages across K closest DHT nodes instead of Firestore.
 * Each message is replicated to K nodes (default 8) for redundancy.
 *
 * Storage model:
 *   - Messages keyed by recipientId (XOR-closest nodes store them)
 *   - Each node maintains a local store for messages it's responsible for
 *   - TTL-based expiry (default 7 days, same as Firestore StoreAndForward)
 *   - Deduplication via messageId
 *
 * Protocol messages (sent via P2PChannelBus or gossip):
 *   - DHT_STORE:    Request a node to store a message
 *   - DHT_RETRIEVE: Request messages for a recipient
 *   - DHT_RESPONSE: Response with stored messages
 *   - DHT_DELETE:   Request deletion of consumed messages
 *
 * This module is purely in-memory and does not depend on Firestore.
 */

import { logger } from '../../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DHTStoredMessage {
  /** Unique message identifier (for dedup) */
  messageId: string;
  /** Intended recipient */
  recipientId: string;
  /** Sender identifier */
  senderId: string;
  /** Room context */
  roomId: string;
  /** Serialized message payload */
  payload: string;
  /** Storage timestamp (ms) */
  storedAt: number;
  /** Expiry timestamp (ms) */
  expiresAt: number;
  /** Number of replica nodes that acknowledged storage */
  replicaCount: number;
}

export type DHTMessageType =
  | 'DHT_STORE'
  | 'DHT_RETRIEVE'
  | 'DHT_RESPONSE'
  | 'DHT_DELETE';

export interface DHTProtocolMessage {
  type: DHTMessageType;
  /** Originator of this DHT request */
  fromId: string;
  /** Target recipient for STORE/RETRIEVE/DELETE */
  recipientId: string;
  /** Room ID context */
  roomId: string;
  /** Message data (for STORE) */
  message?: DHTStoredMessage;
  /** Message IDs (for DELETE) */
  messageIds?: string[];
  /** Retrieved messages (for RESPONSE) */
  messages?: DHTStoredMessage[];
  /** Request ID for correlating responses */
  requestId: string;
}

export interface DHTStorageConfig {
  /** Replication factor (number of nodes to store on, default: 8) */
  replicationFactor: number;
  /** Message TTL in ms (default: 7 days) */
  messageTtlMs: number;
  /** Max messages stored per recipient (default: 1000) */
  maxMessagesPerRecipient: number;
  /** Max total stored messages (default: 10000) */
  maxTotalMessages: number;
  /** Max payload size in bytes (default: 64KB) */
  maxPayloadBytes: number;
  /** Cleanup interval in ms (default: 5 minutes) */
  cleanupIntervalMs: number;
}

const DEFAULT_CONFIG: DHTStorageConfig = {
  replicationFactor: 8,
  messageTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxMessagesPerRecipient: 1000,
  maxTotalMessages: 10000,
  maxPayloadBytes: 64 * 1024,
  cleanupIntervalMs: 5 * 60 * 1000,
};

// ── DHTStorage ──────────────────────────────────────────────────────────────

export class DHTStorage {
  /** Local store: recipientId → messages[] */
  private store = new Map<string, DHTStoredMessage[]>();
  /** Seen message IDs for dedup (LRU bounded) */
  private seenIds = new Set<string>();
  private config: DHTStorageConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private totalMessageCount = 0;

  constructor(config: Partial<DHTStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Local Storage Operations ────────────────────────────────────────────

  /**
   * Store a message locally (called when this node is a DHT replica).
   * Returns true if stored, false if rejected (duplicate, expired, over limit).
   */
  storeMessage(message: DHTStoredMessage): boolean {
    // Dedup check
    if (this.seenIds.has(message.messageId)) {
      return false;
    }

    // Expiry check
    if (Date.now() >= message.expiresAt) {
      return false;
    }

    // Payload size check
    if (message.payload.length > this.config.maxPayloadBytes) {
      logger.warn('[DHTStorage] Payload too large, rejecting', {
        messageId: message.messageId,
        size: message.payload.length,
      });
      return false;
    }

    // Total capacity check
    if (this.totalMessageCount >= this.config.maxTotalMessages) {
      this.pruneExpired(); // Try to make room
      if (this.totalMessageCount >= this.config.maxTotalMessages) {
        logger.warn('[DHTStorage] Storage full, rejecting message');
        return false;
      }
    }

    // Per-recipient capacity check
    const recipientMessages = this.store.get(message.recipientId) ?? [];
    if (recipientMessages.length >= this.config.maxMessagesPerRecipient) {
      logger.warn('[DHTStorage] Recipient inbox full', {
        recipientId: message.recipientId,
      });
      return false;
    }

    recipientMessages.push(message);
    this.store.set(message.recipientId, recipientMessages);
    this.seenIds.add(message.messageId);
    this.totalMessageCount++;

    // Bound seenIds set
    if (this.seenIds.size > this.config.maxTotalMessages * 2) {
      const entries = [...this.seenIds];
      this.seenIds = new Set(entries.slice(entries.length - this.config.maxTotalMessages));
    }

    return true;
  }

  /**
   * Retrieve all non-expired messages for a recipient.
   */
  retrieveMessages(recipientId: string, roomId?: string): DHTStoredMessage[] {
    const messages = this.store.get(recipientId) ?? [];
    const now = Date.now();
    return messages.filter(m =>
      m.expiresAt > now && (roomId === undefined || m.roomId === roomId)
    );
  }

  /**
   * Delete specific messages (after consumption).
   */
  deleteMessages(recipientId: string, messageIds: string[]): number {
    const messages = this.store.get(recipientId);
    if (!messages) return 0;

    const toDelete = new Set(messageIds);
    const before = messages.length;
    const remaining = messages.filter(m => !toDelete.has(m.messageId));
    const deleted = before - remaining.length;

    if (remaining.length === 0) {
      this.store.delete(recipientId);
    } else {
      this.store.set(recipientId, remaining);
    }

    this.totalMessageCount -= deleted;
    return deleted;
  }

  /**
   * Delete all messages for a recipient (after full drain).
   */
  deleteAllForRecipient(recipientId: string): number {
    const messages = this.store.get(recipientId);
    if (!messages) return 0;

    const count = messages.length;
    this.store.delete(recipientId);
    this.totalMessageCount -= count;
    return count;
  }

  // ── DHT Protocol Handling ───────────────────────────────────────────────

  /**
   * Handle an incoming DHT protocol message.
   * Returns a response message if applicable.
   */
  handleProtocolMessage(msg: DHTProtocolMessage): DHTProtocolMessage | null {
    switch (msg.type) {
      case 'DHT_STORE':
        if (msg.message) {
          this.storeMessage(msg.message);
        }
        return null; // No response needed for store

      case 'DHT_RETRIEVE': {
        const messages = this.retrieveMessages(msg.recipientId, msg.roomId);
        return {
          type: 'DHT_RESPONSE',
          fromId: 'local', // Will be overwritten by sender
          recipientId: msg.recipientId,
          roomId: msg.roomId,
          messages,
          requestId: msg.requestId,
        };
      }

      case 'DHT_DELETE':
        if (msg.messageIds) {
          this.deleteMessages(msg.recipientId, msg.messageIds);
        }
        return null;

      case 'DHT_RESPONSE':
        // Responses are handled by the caller, not here
        return null;

      default:
        return null;
    }
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /**
   * Remove all expired messages across all recipients.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [recipientId, messages] of this.store) {
      const valid = messages.filter(m => m.expiresAt > now);
      const removed = messages.length - valid.length;
      pruned += removed;
      this.totalMessageCount -= removed;

      if (valid.length === 0) {
        this.store.delete(recipientId);
      } else {
        this.store.set(recipientId, valid);
      }
    }

    if (pruned > 0) {
      logger.debug('[DHTStorage] Pruned expired messages', { count: pruned });
    }
    return pruned;
  }

  /**
   * Start periodic cleanup of expired messages.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(
      () => this.pruneExpired(),
      this.config.cleanupIntervalMs
    );
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  getMessageCount(): number {
    return this.totalMessageCount;
  }

  getRecipientCount(): number {
    return this.store.size;
  }

  getPendingCount(recipientId: string): number {
    return this.retrieveMessages(recipientId).length;
  }

  hasMessages(recipientId: string): boolean {
    return this.getPendingCount(recipientId) > 0;
  }

  /** Get storage utilization stats */
  getStats(): {
    totalMessages: number;
    recipients: number;
    maxCapacity: number;
    utilizationPercent: number;
  } {
    return {
      totalMessages: this.totalMessageCount,
      recipients: this.store.size,
      maxCapacity: this.config.maxTotalMessages,
      utilizationPercent: (this.totalMessageCount / this.config.maxTotalMessages) * 100,
    };
  }

  destroy(): void {
    this.stopCleanup();
    this.store.clear();
    this.seenIds.clear();
    this.totalMessageCount = 0;
  }
}
