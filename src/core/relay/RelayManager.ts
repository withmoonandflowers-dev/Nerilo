/**
 * RelayManager — Orchestrator for the dual-layer P2P relay system
 *
 * Coordinates all relay infrastructure components:
 * - NATDetector: Classify local NAT for routing decisions
 * - KademliaRouter: DHT-based peer discovery
 * - PeerScoring: GossipSub-style behavior scoring
 * - RateLimiter: Per-peer message rate enforcement
 * - RelayScorer: Node quality scoring for path selection
 * - MultiPathSelector: Independent multi-path construction
 * - MessageAssembler: Receiver-side deduplication
 * - PathQualityTracker: Adaptive feedback loop
 * - CoverTrafficGenerator: Anti-traffic-analysis dummy packets
 * - LocalCreditProvider: Relay incentive credits
 *
 * Lifecycle:
 * 1. initialize() — Detect NAT, build routing table, start services
 * 2. sendViaRelay() — Route message through multi-path relay
 * 3. handleRelayPacket() — Process incoming relay packets
 * 4. shutdown() — Clean up all resources
 */

import { NATDetector } from './NATDetector';
import { KademliaRouter } from './KademliaRouter';
import { PeerScoring } from './PeerScoring';
import { RateLimiter } from './RateLimiter';
import { RelayScorer } from './RelayScorer';
import { MultiPathSelector } from './MultiPathSelector';
import { MessageAssembler } from './MessageAssembler';
import { PathQualityTracker } from './PathQualityTracker';
import { CoverTrafficGenerator } from './CoverTrafficGenerator';
import { padMessage, unpadMessage } from './MessagePadding';
import { LocalCreditProvider } from '../incentive/LocalCreditProvider';
import type {
  RelaySystemState,
  RelayEvent,
  RelayEventType,
  RelayNodeMetrics,
  RelayPath,
} from './types';

/** Relay system configuration */
export interface RelayManagerConfig {
  /** Local node ID (hash of public key) */
  localNodeId: string;
  /** Room ID for this relay context */
  roomId: string;
  /** Maximum relay hops per path */
  maxHopsPerPath: number;
  /** Enable cover traffic */
  enableCoverTraffic: boolean;
  /** Cover traffic lambda (packets/sec) */
  coverTrafficLambda: number;
  /** Rate limit: max messages per 10 minutes */
  rateLimitMax: number;
  /** Minimum relay score to be eligible */
  minRelayScore: number;
}

const DEFAULT_CONFIG: RelayManagerConfig = {
  localNodeId: '',
  roomId: '',
  maxHopsPerPath: 2,
  enableCoverTraffic: false,
  coverTrafficLambda: 0.5,
  rateLimitMax: 100,
  minRelayScore: 0.3,
};

/** Callback for sending raw data to a peer via WebRTC */
export type PeerSendFn = (peerId: string, data: string) => Promise<void>;

/** Callback for delivering assembled messages to the application */
export type MessageDeliveryFn = (
  messageId: string,
  payload: Uint8Array,
  fromPathId: string
) => void;

export class RelayManager {
  private config: RelayManagerConfig;
  private initialized = false;

  // Sub-components
  readonly natDetector = new NATDetector();
  readonly router: KademliaRouter;
  readonly peerScoring = new PeerScoring();
  readonly rateLimiter: RateLimiter;
  readonly relayScorer = new RelayScorer();
  readonly pathSelector = new MultiPathSelector();
  readonly assembler = new MessageAssembler();
  readonly pathTracker = new PathQualityTracker();
  readonly coverTraffic = new CoverTrafficGenerator();
  readonly credits = new LocalCreditProvider();

  // Callbacks
  private peerSendFn: PeerSendFn | null = null;
  private deliveryFn: MessageDeliveryFn | null = null;

  // Event listeners
  private eventListeners = new Map<RelayEventType, Set<(event: RelayEvent) => void>>();

  // Current state
  private activePaths = new Map<string, RelayPath[]>(); // receiverId → paths

  constructor(config: Partial<RelayManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = new KademliaRouter(this.config.localNodeId);
    this.rateLimiter = new RateLimiter({
      maxMessages: this.config.rateLimitMax,
      windowMs: 600_000,
    });
  }

  /**
   * Initialize the relay system.
   * Call this after WebRTC connections are established.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Detect NAT type
    try {
      await this.natDetector.detect();
    } catch {
      // Non-fatal: default to 'unknown'
    }

    // Start services
    this.peerScoring.start();
    this.rateLimiter.start();
    this.assembler.start();

    // Wire up message assembler
    this.assembler.onMessage((messageId, payload, pathId) => {
      if (this.deliveryFn) {
        this.deliveryFn(messageId, payload, pathId);
      }
    });

    this.assembler.onPathFeedback((_messageId, pathId, isFirstArrival, latencyMs) => {
      // Feed back to path quality tracker
      const paths = this.findPathByPathId(pathId);
      if (paths) {
        this.pathTracker.recordDelivery(
          pathId,
          paths.hops,
          true,
          isFirstArrival,
          latencyMs
        );
      }
    });

    // Configure cover traffic
    if (this.config.enableCoverTraffic) {
      this.coverTraffic.setLambda(this.config.coverTrafficLambda);
      this.coverTraffic.setEnabled(true);
      this.coverTraffic.setSender(async (payload) => {
        // Send cover packet through a random relay path
        await this.sendCoverPacket(payload);
      });
      this.coverTraffic.start();
    }

    this.initialized = true;
    this.emitEvent('relay:initialized', { natType: this.natDetector.getNATType() });
  }

  /**
   * Set the function used to send data to peers via WebRTC.
   */
  setPeerSendFunction(fn: PeerSendFn): void {
    this.peerSendFn = fn;
  }

  /**
   * Set the function called when a message is fully assembled and ready.
   */
  onMessageDelivery(fn: MessageDeliveryFn): void {
    this.deliveryFn = fn;
  }

  /**
   * Register a peer in the relay system.
   * Call when a new WebRTC connection is established.
   */
  registerPeer(
    nodeId: string,
    metrics: Partial<RelayNodeMetrics> = {},
    ipHash?: string
  ): void {
    // Add to DHT
    this.router.addNode({
      nodeId,
      lastSeen: Date.now(),
      latency: metrics.avgLatency ?? 100,
      isRelayCapable: true,
      natType: metrics.natType ?? 'unknown',
    });

    // Add to peer scoring
    this.peerScoring.addPeer(nodeId, ipHash);

    // Add to relay scorer
    this.relayScorer.updateMetrics({
      nodeId,
      avgLatency: metrics.avgLatency ?? 100,
      reliability: metrics.reliability ?? 0.5,
      bandwidth: metrics.bandwidth ?? 1000,
      uptimeRatio: metrics.uptimeRatio ?? 0.5,
      natType: metrics.natType ?? 'unknown',
      regionHint: metrics.regionHint,
    });
  }

  /**
   * Unregister a peer from the relay system.
   */
  unregisterPeer(nodeId: string): void {
    this.router.removeNode(nodeId);
    this.peerScoring.removePeer(nodeId);
    this.relayScorer.removeNode(nodeId);
    this.rateLimiter.removePeer(nodeId);
    this.pathTracker.removeNode(nodeId);

    // Invalidate any paths using this node
    for (const [receiverId, paths] of this.activePaths) {
      const updated = paths.filter(
        (p) => !p.hops.includes(nodeId)
      );
      if (updated.length !== paths.length) {
        this.activePaths.set(receiverId, updated);
      }
    }
  }

  /**
   * Update metrics for a peer (called from HeartbeatService data).
   */
  updatePeerMetrics(nodeId: string, metrics: Partial<RelayNodeMetrics>): void {
    const existing = this.relayScorer.scoreNode(nodeId);
    if (!existing) return;

    this.relayScorer.updateMetrics({
      ...existing.metrics,
      ...metrics,
      nodeId,
    });

    this.router.touchNode(nodeId);
  }

  /**
   * Send a message via the multi-path relay network.
   *
   * @param messageId Unique message identifier
   * @param payload Message payload (will be padded and encrypted)
   * @param receiverId Target recipient's node ID
   */
  async sendViaRelay(
    messageId: string,
    payload: Uint8Array,
    receiverId: string
  ): Promise<boolean> {
    if (!this.peerSendFn) {
      throw new Error('Peer send function not set');
    }

    // Check rate limit
    if (!this.rateLimiter.tryConsume(this.config.localNodeId)) {
      this.emitEvent('relay:rate-limited', { nodeId: this.config.localNodeId });
      return false;
    }

    // Get or build relay paths to receiver
    let paths = this.activePaths.get(receiverId);
    if (!paths || paths.length === 0) {
      paths = this.buildPathsTo(receiverId);
      this.activePaths.set(receiverId, paths);
    }

    if (paths.length === 0) {
      // No relay paths — fall back to direct
      return false;
    }

    // Pad the message
    const paddedPayload = padMessage(payload);

    // Send via all active paths simultaneously
    const sendPromises = paths.map(async (path) => {
      try {
        // Build relay envelope
        const envelope = JSON.stringify({
          type: 'relay:forward',
          messageId,
          pathId: path.pathId,
          targetId: receiverId,
          hops: path.hops,
          hopIndex: 0,
          payload: bufferToBase64(paddedPayload.buffer as ArrayBuffer),
          timestamp: Date.now(),
        });

        // Send to first hop
        const firstHop = path.hops[0] ?? receiverId;
        await this.peerSendFn!(firstHop, envelope);

        path.lastUsed = Date.now();
        this.emitEvent('relay:message-sent', { messageId, pathId: path.pathId });
        return true;
      } catch {
        // Record path failure
        this.pathTracker.recordDelivery(
          path.pathId,
          path.hops,
          false,
          false,
          0
        );
        this.emitEvent('relay:path-failed', { pathId: path.pathId });
        return false;
      }
    });

    const results = await Promise.all(sendPromises);
    const anySuccess = results.some((r) => r);

    // Deduct credits for sending
    if (anySuccess) {
      await this.credits.deductCredits(
        this.config.localNodeId,
        Math.ceil(paddedPayload.length / 1024)
      );
      this.emitEvent('relay:credit-spent', {
        nodeId: this.config.localNodeId,
        amount: Math.ceil(paddedPayload.length / 1024),
      });
    }

    return anySuccess;
  }

  /**
   * Handle an incoming relay packet.
   * Called when a relay:forward envelope arrives via WebRTC.
   */
  async handleRelayPacket(fromPeerId: string, data: string): Promise<void> {
    // Check if sender is rate-limited or graylisted
    if (!this.rateLimiter.tryConsume(fromPeerId)) {
      this.emitEvent('relay:rate-limited', { nodeId: fromPeerId });
      return;
    }

    if (this.peerScoring.isGraylisted(fromPeerId)) {
      this.emitEvent('relay:peer-graylisted', { nodeId: fromPeerId });
      return;
    }

    let envelope: {
      type: string;
      messageId: string;
      pathId: string;
      targetId: string;
      hops: string[];
      hopIndex: number;
      payload: string;
      timestamp: number;
    };

    try {
      envelope = JSON.parse(data);
    } catch {
      this.peerScoring.recordInvalidMessage(fromPeerId);
      return;
    }

    if (envelope.type !== 'relay:forward') return;

    // Record successful delivery for scoring
    this.peerScoring.recordDelivery(fromPeerId);

    // Am I the target?
    if (envelope.targetId === this.config.localNodeId) {
      // Deliver to assembler
      const payloadBytes = new Uint8Array(base64ToBuffer(envelope.payload));
      const unpadded = unpadMessage(payloadBytes);
      this.assembler.processMessage(envelope.messageId, unpadded, envelope.pathId);
      this.emitEvent('relay:message-received', {
        messageId: envelope.messageId,
        pathId: envelope.pathId,
      });
      return;
    }

    // I'm a relay node — forward to next hop
    const nextHopIndex = envelope.hopIndex + 1;
    if (nextHopIndex >= envelope.hops.length) {
      // I'm the last relay hop — forward to target
      const forwardEnvelope = JSON.stringify({
        ...envelope,
        hopIndex: nextHopIndex,
      });

      if (this.peerSendFn) {
        try {
          await this.peerSendFn(envelope.targetId, forwardEnvelope);

          // Earn credits for relaying
          const bytesRelayed = envelope.payload.length;
          await this.credits.recordRelay(
            this.config.localNodeId,
            fromPeerId,
            bytesRelayed,
            '' // Simplified proof for Phase 1
          );
          this.emitEvent('relay:credit-earned', {
            nodeId: this.config.localNodeId,
            bytes: bytesRelayed,
          });
        } catch {
          this.pathTracker.recordDelivery(
            envelope.pathId,
            envelope.hops,
            false,
            false,
            0
          );
        }
      }
    } else {
      // Forward to next relay hop
      const nextHop = envelope.hops[nextHopIndex];
      const forwardEnvelope = JSON.stringify({
        ...envelope,
        hopIndex: nextHopIndex,
      });

      if (this.peerSendFn) {
        try {
          await this.peerSendFn(nextHop, forwardEnvelope);

          // Earn credits
          const bytesRelayed = envelope.payload.length;
          await this.credits.recordRelay(
            this.config.localNodeId,
            fromPeerId,
            bytesRelayed,
            ''
          );
          this.emitEvent('relay:credit-earned', {
            nodeId: this.config.localNodeId,
            bytes: bytesRelayed,
          });
        } catch {
          // Forward failed — record
          this.peerScoring.recordDeliveryFailure(nextHop);
        }
      }
    }
  }

  /**
   * Get the current relay system state.
   */
  async getState(): Promise<RelaySystemState> {
    const balance = await this.credits.getBalance(this.config.localNodeId);
    const tier = await this.credits.getServiceTier(this.config.localNodeId);

    let activePathCount = 0;
    for (const paths of this.activePaths.values()) {
      activePathCount += paths.length;
    }

    return {
      initialized: this.initialized,
      localNATType: this.natDetector.getNATType(),
      relayPeerCount: this.relayScorer.getNodeCount(),
      activePathCount,
      serviceTier: tier,
      coverTrafficActive: this.coverTraffic.getStats().isRunning,
      creditBalance: balance.balance,
    };
  }

  /**
   * Subscribe to relay events.
   */
  on(eventType: RelayEventType, handler: (event: RelayEvent) => void): () => void {
    let listeners = this.eventListeners.get(eventType);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventType, listeners);
    }
    listeners.add(handler);
    return () => listeners!.delete(handler);
  }

  /**
   * Shut down the relay system.
   */
  shutdown(): void {
    this.peerScoring.destroy();
    this.rateLimiter.destroy();
    this.assembler.destroy();
    this.coverTraffic.destroy();
    this.router.clear();
    this.relayScorer.clear();
    this.pathTracker.clear();
    this.activePaths.clear();
    this.eventListeners.clear();
    this.initialized = false;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private buildPathsTo(receiverId: string): RelayPath[] {
    const scoredNodes = this.relayScorer.getQualifiedRelays(this.config.minRelayScore);

    // Filter out nodes on the avoidance list
    const avoidList = new Set(this.pathTracker.getAvoidanceList());
    const eligible = scoredNodes.filter((n) => !avoidList.has(n.nodeId));

    const selection = this.pathSelector.selectPaths(
      eligible,
      this.config.localNodeId,
      receiverId,
      this.config.maxHopsPerPath
    );

    return selection.paths;
  }

  private findPathByPathId(pathId: string): RelayPath | null {
    for (const paths of this.activePaths.values()) {
      const found = paths.find((p) => p.pathId === pathId);
      if (found) return found;
    }
    return null;
  }

  private async sendCoverPacket(payload: Uint8Array): Promise<void> {
    if (!this.peerSendFn) return;

    // Send to a random relay-capable peer (loop message)
    const relayNodes = this.router.findRelayNodes(3);
    if (relayNodes.length === 0) return;

    const target = relayNodes[Math.floor(Math.random() * relayNodes.length)];
    const envelope = JSON.stringify({
      type: 'relay:forward',
      messageId: `cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pathId: 'cover',
      targetId: target.nodeId, // Loop back or drop
      hops: [],
      hopIndex: 0,
      payload: bufferToBase64(payload.buffer as ArrayBuffer),
      timestamp: Date.now(),
    });

    try {
      await this.peerSendFn(target.nodeId, envelope);
    } catch {
      // Cover traffic failures are non-critical
    }
  }

  private emitEvent(type: RelayEventType, data: Record<string, unknown>): void {
    const event: RelayEvent = { type, timestamp: Date.now(), data };
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      for (const handler of listeners) {
        try {
          handler(event);
        } catch {
          // Listener errors should not propagate
        }
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
