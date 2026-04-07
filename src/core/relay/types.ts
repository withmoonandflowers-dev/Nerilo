/**
 * Relay Infrastructure Types
 *
 * Foundation types for the dual-layer P2P relay architecture:
 * - Public relay layer (encrypted multi-hop forwarding)
 * - Private direct layer (end-to-end encrypted)
 */

// ── Sphinx-Lite Packet Types ─────────────────────────────────────────────────

/** A single hop in an onion route */
export interface RouteHop {
  /** Peer ID of the relay node */
  nodeId: string;
  /** Ephemeral ECDH public key for this hop (Base64 SPKI) */
  ephemeralPubKey: string;
}

/** Sphinx-Lite packet header (peeled at each hop) */
export interface SphinxHeader {
  /** Version of the packet format */
  version: number;
  /** Ephemeral public key for this hop (Base64) */
  ephemeralKey: string;
  /** Encrypted routing info for this hop */
  routingInfo: string; // Base64 AES-GCM ciphertext
  /** MAC for integrity (Base64) */
  mac: string;
}

/** The inner routing info revealed after decryption at each hop */
export interface RoutingInfo {
  /** Next hop node ID (empty string = final destination) */
  nextHop: string;
  /** Remaining header for the next hop (Base64, empty at final) */
  nextHeader: string;
  /** Delay hint in ms (for cover traffic timing) */
  delayHint: number;
}

/** Complete Sphinx-Lite packet */
export interface SphinxPacket {
  /** Packet header (peeled per hop) */
  header: SphinxHeader;
  /** Encrypted payload (constant size via padding) */
  payload: string; // Base64
  /** Fixed packet size in bytes */
  packetSize: number;
}

// ── Kademlia DHT Types ───────────────────────────────────────────────────────

/** K-Bucket entry for a known peer */
export interface KBucketEntry {
  nodeId: string;
  /** Last seen timestamp */
  lastSeen: number;
  /** RTT latency in ms */
  latency: number;
  /** Whether this node can act as a relay */
  isRelayCapable: boolean;
  /** NAT type of this node */
  natType: NATType;
}

/** Kademlia routing table bucket */
export interface KBucket {
  /** Bucket index (0-255 for 256-bit IDs) */
  index: number;
  /** Entries sorted by last seen (most recent last) */
  entries: KBucketEntry[];
  /** Maximum entries per bucket */
  capacity: number;
}

/** DHT lookup result */
export interface DHTLookupResult {
  /** Target node ID */
  targetId: string;
  /** Closest known nodes */
  closestNodes: KBucketEntry[];
  /** Number of hops taken */
  hopCount: number;
  /** Lookup duration in ms */
  durationMs: number;
}

// ── NAT Types ────────────────────────────────────────────────────────────────

export type NATType = 'open' | 'full-cone' | 'restricted' | 'port-restricted' | 'symmetric' | 'unknown';

// ── Relay Scoring Types ──────────────────────────────────────────────────────

/** Raw metrics for scoring a relay node */
export interface RelayNodeMetrics {
  nodeId: string;
  /** Average RTT in ms */
  avgLatency: number;
  /** Message delivery success rate (0-1) */
  reliability: number;
  /** Estimated bandwidth in kbps */
  bandwidth: number;
  /** Uptime ratio (0-1) */
  uptimeRatio: number;
  /** NAT type */
  natType: NATType;
  /** Geographic region hint (for path diversity) */
  regionHint?: string;
}

/** Scored relay node with composite score */
export interface ScoredRelayNode {
  nodeId: string;
  /** Composite score (0-1, higher is better) */
  score: number;
  /** Individual factor scores */
  factors: {
    latency: number;
    reliability: number;
    bandwidth: number;
    uptime: number;
    diversity: number;
  };
  /** Raw metrics snapshot */
  metrics: RelayNodeMetrics;
}

// ── Multi-Path Types ─────────────────────────────────────────────────────────

/** A single relay path from sender to receiver */
export interface RelayPath {
  /** Unique path identifier */
  pathId: string;
  /** Ordered list of relay node IDs (excluding sender/receiver) */
  hops: string[];
  /** Estimated end-to-end latency in ms */
  estimatedLatency: number;
  /** Composite path score */
  pathScore: number;
  /** Whether this path is currently active */
  isActive: boolean;
  /** Last time this path was used successfully */
  lastUsed: number;
}

/** Multi-path selection result */
export interface MultiPathSelection {
  /** Selected paths (2-4, ordered by score descending) */
  paths: RelayPath[];
  /** Primary path index */
  primaryPathIndex: number;
  /** Reason for path count selection */
  pathCountReason: string;
}

// ── Message Assembly Types ───────────────────────────────────────────────────

/** Fragment of a large message */
export interface MessageFragment {
  /** Original message ID */
  messageId: string;
  /** Fragment index (0-based) */
  fragmentIndex: number;
  /** Total number of fragments */
  totalFragments: number;
  /** Fragment payload (Base64) */
  data: string;
  /** Path ID this fragment arrived on */
  pathId: string;
}

/** Assembled message status */
export interface AssemblyStatus {
  messageId: string;
  /** Fragments received so far */
  receivedFragments: number;
  totalFragments: number;
  /** Which path delivered the first complete copy */
  winningPathId: string | null;
  /** Timestamp of first fragment arrival */
  firstArrivalAt: number;
  /** Whether assembly is complete */
  isComplete: boolean;
}

// ── Peer Scoring Types ───────────────────────────────────────────────────────

/** Per-peer behavior scores (GossipSub v1.1 inspired) */
export interface PeerBehaviorScore {
  nodeId: string;
  /** Message delivery rate (successful forwards / total requests) */
  deliveryRate: number;
  /** Number of invalid messages received from this peer */
  invalidMessageCount: number;
  /** Number of duplicate messages sent (indicates mesh inefficiency or spam) */
  duplicatesSent: number;
  /** Time spent in mesh (longer = more trusted) */
  meshPresenceMs: number;
  /** First-arrival rate: how often this peer's path delivers first */
  firstArrivalRate: number;
  /** IP address hash (for colocation detection) */
  ipHash?: string;
  /** Composite behavior score (-100 to +100) */
  compositeScore: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

/** Scoring thresholds (configurable) */
export interface ScoringThresholds {
  /** Below this score, suppress gossip to/from this peer */
  gossipThreshold: number;
  /** Below this score, stop accepting messages from this peer */
  graylistThreshold: number;
  /** Below this score, disconnect from this peer */
  disconnectThreshold: number;
  /** Above this score, consider for relay duties */
  relayEligibleThreshold: number;
}

// ── Rate Limiting Types ──────────────────────────────────────────────────────

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Maximum messages per window */
  maxMessages: number;
  /** Window duration in ms */
  windowMs: number;
  /** Penalty for exceeding (ms to block) */
  penaltyMs: number;
}

/** Rate limit status for a peer */
export interface RateLimitStatus {
  nodeId: string;
  /** Messages sent in current window */
  messageCount: number;
  /** Window start timestamp */
  windowStart: number;
  /** Whether currently rate-limited */
  isLimited: boolean;
  /** When the rate limit expires (0 if not limited) */
  limitExpiresAt: number;
}

// ── Cover Traffic Types ──────────────────────────────────────────────────────

/** Cover traffic configuration */
export interface CoverTrafficConfig {
  /** Whether cover traffic is enabled */
  enabled: boolean;
  /** Poisson lambda parameter (avg packets per second) */
  poissonLambda: number;
  /** Fixed packet size in bytes (must match real packets) */
  packetSize: number;
  /** Whether to reduce cover traffic on battery */
  batteryAware: boolean;
  /** Minimum cover traffic rate when on battery (fraction of normal) */
  batteryMinRate: number;
}

// ── Incentive Types ──────────────────────────────────────────────────────────

/** Relay credit receipt (signed by both parties) */
export interface RelayReceipt {
  /** Unique receipt ID */
  receiptId: string;
  /** Who relayed the data */
  relayNodeId: string;
  /** Who requested the relay */
  requesterNodeId: string;
  /** Bytes relayed */
  bytesRelayed: number;
  /** Timestamp */
  timestamp: number;
  /** Relay node's signature (Base64) */
  relaySignature: string;
  /** Requester's acknowledgment signature (Base64) */
  requesterSignature?: string;
}

/** Credit balance for a node */
export interface CreditBalance {
  nodeId: string;
  /** Total credits earned from relaying */
  earned: number;
  /** Total credits spent on sending */
  spent: number;
  /** Current balance */
  balance: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

/** Service tier based on credit balance */
export type ServiceTier = 'free' | 'basic' | 'premium';

// ── Relay Manager Types ──────────────────────────────────────────────────────

/** Overall relay system state */
export interface RelaySystemState {
  /** Whether the relay system is initialized */
  initialized: boolean;
  /** Local node's NAT type */
  localNATType: NATType;
  /** Number of known relay-capable peers */
  relayPeerCount: number;
  /** Number of active relay paths */
  activePathCount: number;
  /** Current service tier */
  serviceTier: ServiceTier;
  /** Cover traffic status */
  coverTrafficActive: boolean;
  /** Credit balance */
  creditBalance: number;
}

/** Relay event types for the event bus */
export type RelayEventType =
  | 'relay:initialized'
  | 'relay:path-established'
  | 'relay:path-failed'
  | 'relay:message-sent'
  | 'relay:message-received'
  | 'relay:message-assembled'
  | 'relay:peer-scored'
  | 'relay:peer-graylisted'
  | 'relay:rate-limited'
  | 'relay:credit-earned'
  | 'relay:credit-spent'
  | 'relay:nat-detected'
  | 'relay:cover-traffic-toggled';

/** Generic relay event */
export interface RelayEvent {
  type: RelayEventType;
  timestamp: number;
  data: Record<string, unknown>;
}
