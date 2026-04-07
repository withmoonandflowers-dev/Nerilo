/**
 * DHTStoreAndForward — Hybrid Decentralized Store-and-Forward
 *
 * Coordinates KademliaRouter + DHTStorage to provide decentralized
 * offline message delivery without Firestore dependency.
 *
 * Strategy:
 *   1. Find K closest nodes to recipientId via Kademlia routing
 *   2. Send DHT_STORE to each replica node (fire-and-forget)
 *   3. Also store locally if we're among the K closest
 *   4. On retrieval, query K closest nodes with DHT_RETRIEVE
 *   5. Merge and dedup responses, deliver to recipient
 *
 * This replaces StoreAndForward for P2P-native message persistence.
 * The original StoreAndForward (Firestore) remains available as a
 * fallback when the DHT overlay has insufficient nodes.
 */

import { logger } from '../../utils/logger';
import { generateUUID } from '../../utils/uuid';
import { KademliaRouter } from '../relay/KademliaRouter';
import {
  DHTStorage,
  type DHTStoredMessage,
  type DHTProtocolMessage,
  type DHTStorageConfig,
} from './DHTStorage';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DHTStoreAndForwardConfig {
  /** Minimum DHT nodes required for decentralized storage (default: 3) */
  minDHTNodes: number;
  /** Storage config passed to underlying DHTStorage */
  storageConfig?: Partial<DHTStorageConfig>;
}

type SendFunction = (targetNodeId: string, message: DHTProtocolMessage) => void;
type InboxHandler = (from: string, payload: string) => void;

const DEFAULT_CONFIG: DHTStoreAndForwardConfig = {
  minDHTNodes: 3,
};

// ── DHTStoreAndForward ──────────────────────────────────────────────────────

export class DHTStoreAndForward {
  private localStorage: DHTStorage;
  private router: KademliaRouter;
  private config: DHTStoreAndForwardConfig;
  private localId: string;
  /** Function to send protocol messages to other DHT nodes */
  private sendFn: SendFunction | null = null;
  /** Pending retrieve callbacks: requestId → handler */
  private pendingRetrieves = new Map<string, {
    handler: InboxHandler;
    responses: DHTStoredMessage[];
    expectedResponses: number;
    receivedResponses: number;
    seenIds: Set<string>;
    timeoutId: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    localId: string,
    router: KademliaRouter,
    config: Partial<DHTStoreAndForwardConfig> = {}
  ) {
    this.localId = localId;
    this.router = router;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.localStorage = new DHTStorage(this.config.storageConfig);
  }

  /**
   * Set the function used to send DHT protocol messages to peers.
   * This bridges DHTStoreAndForward with the P2P transport layer.
   */
  setSendFunction(fn: SendFunction): void {
    this.sendFn = fn;
  }

  // ── Store ─────────────────────────────────────────────────────────────

  /**
   * Store an offline message for a recipient using DHT replication.
   * Returns the messageId and the number of replica nodes contacted.
   */
  store(
    roomId: string,
    recipientId: string,
    senderId: string,
    payload: string
  ): { messageId: string; replicasSent: number } {
    const messageId = generateUUID();
    const now = Date.now();
    const ttlMs = this.localStorage['config'].messageTtlMs;

    const message: DHTStoredMessage = {
      messageId,
      recipientId,
      senderId,
      roomId,
      payload,
      storedAt: now,
      expiresAt: now + ttlMs,
      replicaCount: 0,
    };

    // Find K closest nodes to the recipient
    const closestNodes = this.router.findClosest(recipientId);
    let replicasSent = 0;

    // Store locally if we're responsible
    const stored = this.localStorage.storeMessage(message);
    if (stored) replicasSent++;

    // Send to other K closest nodes
    if (this.sendFn) {
      for (const node of closestNodes) {
        if (node.nodeId === this.localId) continue;

        const protocolMsg: DHTProtocolMessage = {
          type: 'DHT_STORE',
          fromId: this.localId,
          recipientId,
          roomId,
          message: { ...message, replicaCount: closestNodes.length },
          requestId: messageId,
        };

        try {
          this.sendFn(node.nodeId, protocolMsg);
          replicasSent++;
        } catch {
          logger.warn('[DHTStoreAndForward] Failed to send to replica', {
            nodeId: node.nodeId,
          });
        }
      }
    }

    logger.info('[DHTStoreAndForward] Message stored', {
      messageId,
      recipientId,
      replicasSent,
      totalClosestNodes: closestNodes.length,
    });

    return { messageId, replicasSent };
  }

  // ── Retrieve ──────────────────────────────────────────────────────────

  /**
   * Retrieve stored messages for the local user.
   * Queries K closest nodes and merges responses.
   * Returns local messages immediately; remote responses arrive via callback.
   */
  retrieve(
    roomId: string,
    recipientId: string,
    handler: InboxHandler
  ): { localMessages: number; remoteQueriesSent: number } {
    // First, deliver local messages
    const localMessages = this.localStorage.retrieveMessages(recipientId, roomId);
    let localCount = 0;
    const deliveredIds: string[] = [];

    for (const msg of localMessages) {
      try {
        handler(msg.senderId, msg.payload);
        deliveredIds.push(msg.messageId);
        localCount++;
      } catch (err) {
        logger.warn('[DHTStoreAndForward] Handler error', { error: err });
      }
    }

    // Delete consumed local messages
    if (deliveredIds.length > 0) {
      this.localStorage.deleteMessages(recipientId, deliveredIds);
    }

    // Query remote K closest nodes
    const closestNodes = this.router.findClosest(recipientId);
    const remoteNodes = closestNodes.filter(n => n.nodeId !== this.localId);
    let remoteQueriesSent = 0;

    if (this.sendFn && remoteNodes.length > 0) {
      const requestId = generateUUID();

      // Set up response collector with timeout
      const timeoutId = setTimeout(() => {
        this.finalizePendingRetrieve(requestId);
      }, 10_000); // 10 second timeout

      this.pendingRetrieves.set(requestId, {
        handler,
        responses: [],
        expectedResponses: remoteNodes.length,
        receivedResponses: 0,
        seenIds: new Set(deliveredIds),
        timeoutId,
      });

      for (const node of remoteNodes) {
        const protocolMsg: DHTProtocolMessage = {
          type: 'DHT_RETRIEVE',
          fromId: this.localId,
          recipientId,
          roomId,
          requestId,
        };

        try {
          this.sendFn(node.nodeId, protocolMsg);
          remoteQueriesSent++;
        } catch {
          // best effort
        }
      }
    }

    return { localMessages: localCount, remoteQueriesSent };
  }

  /**
   * Drain all local messages for a recipient (one-shot consume).
   * Does not query remote nodes — use retrieve() for full DHT lookup.
   */
  drainLocal(
    roomId: string,
    recipientId: string,
    handler: InboxHandler
  ): number {
    const messages = this.localStorage.retrieveMessages(recipientId, roomId);
    let consumed = 0;
    const consumedIds: string[] = [];

    for (const msg of messages) {
      try {
        handler(msg.senderId, msg.payload);
        consumedIds.push(msg.messageId);
        consumed++;
      } catch {
        // skip failed messages
      }
    }

    if (consumedIds.length > 0) {
      this.localStorage.deleteMessages(recipientId, consumedIds);
    }

    return consumed;
  }

  // ── Protocol Message Handling ──────────────────────────────────────────

  /**
   * Handle an incoming DHT protocol message from the network.
   * Routes to the local DHTStorage and sends responses as needed.
   */
  handleIncoming(msg: DHTProtocolMessage): void {
    switch (msg.type) {
      case 'DHT_STORE':
        this.localStorage.handleProtocolMessage(msg);
        break;

      case 'DHT_RETRIEVE': {
        const response = this.localStorage.handleProtocolMessage(msg);
        if (response && this.sendFn) {
          response.fromId = this.localId;
          try {
            this.sendFn(msg.fromId, response);
          } catch {
            // best effort
          }
        }
        break;
      }

      case 'DHT_RESPONSE':
        this.handleRetrieveResponse(msg);
        break;

      case 'DHT_DELETE':
        this.localStorage.handleProtocolMessage(msg);
        break;
    }
  }

  /**
   * Handle a DHT_RESPONSE from a remote node.
   */
  private handleRetrieveResponse(msg: DHTProtocolMessage): void {
    const pending = this.pendingRetrieves.get(msg.requestId);
    if (!pending) return;

    pending.receivedResponses++;

    // Dedup and deliver
    if (msg.messages) {
      for (const storedMsg of msg.messages) {
        if (pending.seenIds.has(storedMsg.messageId)) continue;
        pending.seenIds.add(storedMsg.messageId);

        try {
          pending.handler(storedMsg.senderId, storedMsg.payload);
          pending.responses.push(storedMsg);
        } catch {
          // skip
        }
      }
    }

    // Check if all responses received
    if (pending.receivedResponses >= pending.expectedResponses) {
      this.finalizePendingRetrieve(msg.requestId);
    }
  }

  private finalizePendingRetrieve(requestId: string): void {
    const pending = this.pendingRetrieves.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pendingRetrieves.delete(requestId);

    // Send delete requests to remote nodes for consumed messages
    if (pending.responses.length > 0 && this.sendFn) {
      const messageIds = pending.responses.map(m => m.messageId);
      const recipientId = pending.responses[0]!.recipientId;
      const roomId = pending.responses[0]!.roomId;
      const closestNodes = this.router.findClosest(recipientId);

      for (const node of closestNodes) {
        if (node.nodeId === this.localId) continue;
        try {
          this.sendFn(node.nodeId, {
            type: 'DHT_DELETE',
            fromId: this.localId,
            recipientId,
            roomId,
            messageIds,
            requestId: generateUUID(),
          });
        } catch {
          // best effort
        }
      }
    }
  }

  // ── Utility ─────────────────────────────────────────────────────────────

  /**
   * Check if DHT has enough nodes for decentralized storage.
   * If not, callers should fall back to Firestore StoreAndForward.
   */
  hasSufficientNodes(): boolean {
    return this.router.getNodeCount() >= this.config.minDHTNodes;
  }

  /**
   * Get the number of locally stored messages.
   */
  getLocalMessageCount(): number {
    return this.localStorage.getMessageCount();
  }

  /**
   * Get local pending count for a recipient.
   */
  getLocalPendingCount(recipientId: string): number {
    return this.localStorage.getPendingCount(recipientId);
  }

  /**
   * Get storage stats.
   */
  getStats(): ReturnType<DHTStorage['getStats']> & {
    dhtNodeCount: number;
    hasSufficientNodes: boolean;
  } {
    return {
      ...this.localStorage.getStats(),
      dhtNodeCount: this.router.getNodeCount(),
      hasSufficientNodes: this.hasSufficientNodes(),
    };
  }

  /**
   * Start periodic cleanup.
   */
  startCleanup(): void {
    this.localStorage.startCleanup();
  }

  /**
   * Prune expired messages.
   */
  pruneExpired(): number {
    return this.localStorage.pruneExpired();
  }

  destroy(): void {
    this.localStorage.destroy();
    for (const pending of this.pendingRetrieves.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingRetrieves.clear();
    this.sendFn = null;
  }
}
