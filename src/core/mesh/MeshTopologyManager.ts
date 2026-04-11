import { MeshConnection } from './MeshConnection';
import { RoomService } from '../../services/RoomService';
import { ref, onValue } from 'firebase/database';
import { rtdb } from '../../config/firebase';
import { RTDB } from '../../config/rtdb-paths';
import { logger } from '../../utils/logger';
import { AdaptiveTopologyManager, type TopologyStrategy, type GossipConfig } from './AdaptiveTopologyManager';

/**
 * Mesh Topology Manager
 * Manages neighbor connections, node discovery, and connection rotation.
 * Uses AdaptiveTopologyManager to dynamically adjust topology strategy
 * based on participant count.
 */
export class MeshTopologyManager {
  private neighbors: Map<string, MeshConnection> = new Map();
  private k = 6; // Target neighbor count (dynamically adjusted by AdaptiveTopologyManager)
  private adaptiveTopology = new AdaptiveTopologyManager();
  private currentStrategy: TopologyStrategy = 'full-mesh';
  private currentGossipConfig: GossipConfig = { fanout: 5, ttl: 1 };
  private rotationInterval: ReturnType<typeof setInterval> | null = null;
  private rotationStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private identityMap: Map<string, string> = new Map(); // firebaseUid -> userId
  /** RTDB real-time subscription (for reactive node discovery) */
  private discoveryUnsubscribe: (() => void) | null = null;

  /** Reconnect retry settings */
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

  /** Track per-peer retry count to avoid infinite retries */
  private reconnectAttempts: Map<string, number> = new Map();
  /** In-progress reconnect timers, need to clear on cleanup */
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private roomId: string,
    private localUserId: string,
    private localFirebaseUid: string
  ) {}

  /**
   * Initialize (establish initial neighbor connections)
   */
  async initialize(): Promise<void> {
    logger.info('[MeshTopologyManager] Initializing', {
      roomId: this.roomId,
      localUserId: this.localUserId,
      localFirebaseUid: this.localFirebaseUid,
    });

    // Strategy: RTDB real-time subscription + reactive connections.
    // Instead of fixed wait + polling, use onValue to listen for meshIdentities changes.
    // When a new node registers its identity, immediately attempt connection,
    // significantly reducing discovery latency.
    //
    // Also do an initial read: if other nodes already exist, connect immediately.
    const initialCandidates = await this.discoverNodes();
    if (initialCandidates.length > 0) {
      logger.info('[MeshTopologyManager] Initial candidates found', {
        roomId: this.roomId,
        count: initialCandidates.length,
      });
      const maxNeighbors = Math.min(this.k, initialCandidates.length);
      const selected = await this.selectNeighbors(initialCandidates, maxNeighbors);
      this.connectToNeighbors(selected).catch(error => {
        logger.error('[MeshTopologyManager] Error connecting to initial neighbors', { error });
      });
    }

    // Start RTDB real-time subscription: listen for room meshIdentities changes
    this.startReactiveDiscovery();

    // Delay starting neighbor rotation (15s to give all nodes time to establish initial connections)
    this.rotationStartTimeout = setTimeout(() => {
      this.rotationStartTimeout = null;
      if (this.neighbors.size > 0) {
        this.startRotation();
        logger.info('[MeshTopologyManager] Rotation started', {
          roomId: this.roomId,
          neighborCount: this.neighbors.size,
        });
      }
    }, 15000);
  }

  /**
   * Start RTDB real-time subscription. When a new node joins (registers meshIdentity),
   * automatically attempt connection. This solves the race condition where
   * everyone joins simultaneously and can't see each other.
   */
  private startReactiveDiscovery(): void {
    const roomRef = ref(rtdb, RTDB.room(this.roomId));

    this.discoveryUnsubscribe = onValue(roomRef, (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.val();
      if (!data?.meshIdentities) return;

      const newCandidates: string[] = [];

      for (const [firebaseUid, identity] of Object.entries(data.meshIdentities)) {
        if (firebaseUid === this.localFirebaseUid) continue;
        const typedIdentity = identity as { userId: string; pubKey: string; joinedAt: unknown };
        const userId = typedIdentity.userId;

        // Update identity map
        this.identityMap.set(firebaseUid, userId);

        // If this node is not an existing neighbor and not currently reconnecting, add to candidates
        if (!this.neighbors.has(userId) && !this.reconnectAttempts.has(userId)) {
          newCandidates.push(userId);
        }
      }

      if (newCandidates.length > 0 && this.neighbors.size < this.k) {
        logger.info('[MeshTopologyManager] Reactive discovery: new candidates found', {
          roomId: this.roomId,
          newCandidates,
          currentNeighbors: this.neighbors.size,
        });
        const toConnect = newCandidates.slice(0, this.k - this.neighbors.size);
        this.connectToNeighbors(toConnect).catch(error => {
          logger.error('[MeshTopologyManager] Reactive connect error', { error });
        });
      }
    }, (error) => {
      logger.warn('[MeshTopologyManager] Reactive discovery error', { error });
    });
  }

  /**
   * Connect to neighbors (with retry mechanism)
   */
  async connectToNeighbors(targetUserIds: string[]): Promise<void> {
    for (const userId of targetUserIds) {
      if (this.neighbors.size >= this.k) break;
      if (this.neighbors.has(userId)) continue;
      if (userId === this.localUserId) continue;

      await this.connectToSingleNeighbor(userId);
    }
  }

  /**
   * Connect to a single neighbor, schedule exponential backoff retry on failure
   */
  private async connectToSingleNeighbor(userId: string): Promise<void> {
    try {
      // Prevent resource leaks: if a connection object already exists, close it first
      const existing = this.neighbors.get(userId);
      if (existing) {
        logger.info('[MeshTopologyManager] Closing existing connection before reconnect', {
          roomId: this.roomId,
          remoteUserId: userId,
        });
        this.neighbors.delete(userId);
        await existing.close().catch(() => {});
      }

      const isInitiator = this.localUserId < userId;
      const remoteFirebaseUid = this.getFirebaseUidFromUserId(userId);
      const localFirebaseUid = this.localFirebaseUid;

      if (!remoteFirebaseUid) {
        logger.info('[MeshTopologyManager] Remote Firebase UID not found, scheduling retry', {
          roomId: this.roomId,
          remoteUserId: userId,
        });
        this.scheduleReconnect(userId);
        return;
      }

      const connection = new MeshConnection(
        this.roomId,
        localFirebaseUid,
        remoteFirebaseUid,
        userId,
        isInitiator
      );

      this.neighbors.set(userId, connection);

      logger.info('[MeshTopologyManager] Initiating connection to neighbor', {
        roomId: this.roomId,
        remoteUserId: userId,
        remoteFirebaseUid,
        isInitiator,
      });

      // Wait for connection ready, close and schedule retry on failure
      connection.waitForReady()
        .then(() => {
          // Connection succeeded, reset retry count
          this.reconnectAttempts.delete(userId);
          logger.info('[MeshTopologyManager] Connection ready', {
            roomId: this.roomId,
            remoteUserId: userId,
          });
        })
        .catch(async (error) => {
          logger.warn('[MeshTopologyManager] Connection not ready, closing and scheduling retry', {
            roomId: this.roomId,
            remoteUserId: userId,
            error,
          });
          // Only clear from neighbors if it's still the same connection object
          // (might have been replaced by a new connectToSingleNeighbor call during the wait)
          if (this.neighbors.get(userId) === connection) {
            this.neighbors.delete(userId);
          }
          await connection.close().catch(() => {});
          this.scheduleReconnect(userId);
        });
    } catch (error) {
      logger.warn('[MeshTopologyManager] Failed to connect to neighbor, scheduling retry', {
        roomId: this.roomId,
        remoteUserId: userId,
        error,
      });
      this.scheduleReconnect(userId);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(userId: string): void {
    const attempts = this.reconnectAttempts.get(userId) ?? 0;
    if (attempts >= MeshTopologyManager.MAX_RECONNECT_ATTEMPTS) {
      logger.warn('[MeshTopologyManager] Max reconnect attempts reached, giving up', {
        roomId: this.roomId,
        remoteUserId: userId,
        attempts,
      });
      this.reconnectAttempts.delete(userId);
      return;
    }

    // Exponential backoff + jitter: delay = min(base * 2^attempts + jitter, max)
    // Jitter is +/-10% to avoid thundering herd (#32)
    const baseDelay = MeshTopologyManager.BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts);
    const jitter = (Math.random() - 0.5) * baseDelay * 0.2;
    const delay = Math.min(baseDelay + jitter, MeshTopologyManager.MAX_RECONNECT_DELAY_MS);

    this.reconnectAttempts.set(userId, attempts + 1);

    logger.info('[MeshTopologyManager] Scheduling reconnect', {
      roomId: this.roomId,
      remoteUserId: userId,
      attempt: attempts + 1,
      maxAttempts: MeshTopologyManager.MAX_RECONNECT_ATTEMPTS,
      delayMs: Math.round(delay),
    });

    // Clear existing timer (avoid duplicate scheduling)
    const existingTimer = this.reconnectTimers.get(userId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(userId);
      // If already have this neighbor (connected via another path), skip
      if (this.neighbors.has(userId)) return;
      // If at capacity, skip
      if (this.neighbors.size >= this.k) return;

      // Re-discover nodes to update identityMap (peer might have registered identity during the wait)
      await this.discoverNodes();
      await this.connectToSingleNeighbor(userId);
    }, delay);

    this.reconnectTimers.set(userId, timer);
  }

  /**
   * Get Firebase UID from userId
   */
  private getFirebaseUidFromUserId(userId: string): string | null {
    for (const [firebaseUid, mappedUserId] of this.identityMap.entries()) {
      if (mappedUserId === userId) {
        return firebaseUid;
      }
    }
    return null;
  }

  /**
   * Handle neighbor disconnection: first try reconnecting the same peer,
   * then fill in with other peers if that fails
   */
  async handleNeighborDisconnected(neighborId: string): Promise<void> {
    logger.info('[MeshTopologyManager] Neighbor disconnected', {
      roomId: this.roomId,
      neighborId,
    });

    const neighbor = this.neighbors.get(neighborId);
    if (neighbor) {
      await neighbor.close();
      this.neighbors.delete(neighborId);
    }

    // Try reconnecting the same peer first (reset retry count, give it a fresh chance)
    this.reconnectAttempts.delete(neighborId);
    this.scheduleReconnect(neighborId);

    // Also fill in with other peers to ensure sufficient neighbor count
    await this.fillNeighbors();
  }

  /**
   * Fill neighbors to target count
   */
  private async fillNeighbors(): Promise<void> {
    if (this.neighbors.size >= this.k) return;

    const candidates = await this.discoverNodes();
    const needed = this.k - this.neighbors.size;
    const selected = await this.selectNeighbors(candidates, needed);

    await this.connectToNeighbors(selected);
  }

  /**
   * Start connection rotation
   */
  startRotation(): void {
    this.rotationInterval = setInterval(() => {
      this.rotateConnection();
    }, 2 * 60 * 1000); // 2 minutes
  }

  /**
   * Rotate one connection
   */
  private async rotateConnection(): Promise<void> {
    if (this.neighbors.size < this.k) {
      await this.fillNeighbors();
      return;
    }

    const neighborsArray = Array.from(this.neighbors.keys());
    const toRemove = neighborsArray[Math.floor(Math.random() * neighborsArray.length)];

    const neighbor = this.neighbors.get(toRemove);
    if (neighbor) {
      await neighbor.close();
      this.neighbors.delete(toRemove);
    }

    await this.fillNeighbors();
  }

  /**
   * Discover nodes
   */
  private async discoverNodes(): Promise<string[]> {
    const discoveredUserIds = new Set<string>();

    // Method 1: Get room participants and mesh identity info from RoomService
    try {
      const room = await RoomService.getRoom(this.roomId, true);
      if (room) {
        // participants in RTDB is {uid: true} object — convert with Object.keys()
        const participants = room.participants
          ? (Array.isArray(room.participants)
              ? room.participants
              : Object.keys(room.participants))
          : [];

        // Get meshIdentities
        if (room.meshIdentities) {
          for (const [firebaseUid, identity] of Object.entries(room.meshIdentities)) {
            if (firebaseUid !== this.localFirebaseUid) {
              discoveredUserIds.add(identity.userId);
              this.identityMap.set(firebaseUid, identity.userId);
            }
          }
        } else if (participants.length >= 2) {
          // If no meshIdentities yet but already have participants, wait
          // Other participants may still be registering their identities
          logger.info('[MeshTopologyManager] No meshIdentities yet, participants may still be registering', {
            roomId: this.roomId,
            participants: participants.length,
          });
        }
      }
    } catch (error) {
      logger.warn('[MeshTopologyManager] Failed to get room from RTDB', { error });
    }

    // Method 2: Get neighbor lists from existing neighbors (simplified, not implemented yet)

    return Array.from(discoveredUserIds);
  }

  /**
   * Select neighbors
   */
  private async selectNeighbors(
    candidates: string[],
    count: number
  ): Promise<string[]> {
    // Filter out nodes that are already neighbors
    const available = candidates.filter(
      userId => !this.neighbors.has(userId) && userId !== this.localUserId
    );

    // Simple strategy: random selection
    // Future: add connection quality evaluation
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, available.length));
  }

  /**
   * Get all neighbors
   */
  getNeighbors(): MeshConnection[] {
    return Array.from(this.neighbors.values());
  }

  /**
   * Get neighbor count
   */
  getNeighborCount(): number {
    return this.neighbors.size;
  }

  /**
   * Update topology strategy based on participant count.
   * Called by MeshGossipManager when participants change.
   */
  updateParticipantCount(participantCount: number): void {
    const evaluation = this.adaptiveTopology.evaluateTopology(participantCount);
    const oldK = this.k;
    const oldStrategy = this.currentStrategy;

    this.k = evaluation.targetNeighborCount;
    this.currentStrategy = evaluation.strategy;
    this.currentGossipConfig = evaluation.gossipConfig;

    if (oldStrategy !== evaluation.strategy || oldK !== this.k) {
      logger.info('[MeshTopologyManager] Topology updated', {
        roomId: this.roomId,
        participantCount,
        strategy: evaluation.strategy,
        k: this.k,
        gossipConfig: evaluation.gossipConfig,
      });

      // Adjust neighbor count if needed
      if (this.k > oldK) {
        this.fillNeighbors().catch((err) => {
          logger.warn('[MeshTopologyManager] fillNeighbors after upgrade failed', err);
        });
      }
      // Downgrade: gradually reduce connections (handled by rotation)
    }
  }

  /** Current topology strategy */
  getStrategy(): TopologyStrategy {
    return this.currentStrategy;
  }

  /** Current gossip configuration (fanout + ttl) */
  getGossipConfig(): GossipConfig {
    return this.currentGossipConfig;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Stop RTDB real-time subscription
    if (this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe();
      this.discoveryUnsubscribe = null;
    }

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    if (this.rotationStartTimeout) {
      clearTimeout(this.rotationStartTimeout);
      this.rotationStartTimeout = null;
    }
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = null;
    }

    const closePromises = Array.from(this.neighbors.values()).map(neighbor =>
      neighbor.close().catch(error => {
        logger.error('[MeshTopologyManager] Error closing neighbor', { error });
      })
    );

    await Promise.allSettled(closePromises);
    this.neighbors.clear();
    this.identityMap.clear();
  }
}
