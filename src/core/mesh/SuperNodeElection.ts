/**
 * Super Node Election
 *
 * For large rooms (20+ participants), elects high-quality nodes as relay hubs.
 * Uses deterministic scoring + ranking so all peers converge to the same result.
 *
 * Score = uptime(30%) + bandwidth(25%) + latency(25%) + battery(10%) + nat(10%)
 */

export interface PeerScore {
  peerId: string;
  /** Uptime in seconds (higher = better) */
  uptimeSeconds: number;
  /** Estimated bandwidth in Kbps (higher = better) */
  bandwidthKbps: number;
  /** Average RTT in ms (lower = better) */
  latencyMs: number;
  /** Battery level 0-1 (higher = better), null if unavailable */
  batteryLevel: number | null;
  /** NAT type: 'open' | 'full-cone' | 'restricted' | 'symmetric' */
  natType: NATType;
  /** CPU logical core count, null if unavailable */
  cpuCores?: number | null;
  /** Device memory in GB, null if unavailable */
  memoryGb?: number | null;
  /** Network connection type */
  networkType?: 'wifi' | '4g' | '5g' | '3g' | '2g' | 'ethernet' | 'unknown';
  /** Device type hint */
  deviceType?: 'mobile' | 'tablet' | 'desktop' | 'unknown';
}

export type NATType = 'open' | 'full-cone' | 'restricted' | 'symmetric';

export interface ElectionResult {
  superNodes: string[];
  scores: Map<string, number>;
}

/** Weights for each scoring component (total = 1.0) */
const WEIGHTS = {
  uptime: 0.22,
  bandwidth: 0.20,
  latency: 0.20,
  battery: 0.08,
  nat: 0.08,
  cpu: 0.08,
  memory: 0.07,
  network: 0.07,
} as const;

/** NAT type quality scores (0-1) */
const NAT_SCORES: Record<NATType, number> = {
  'open': 1.0,
  'full-cone': 0.8,
  'restricted': 0.5,
  'symmetric': 0.2,
};

/** Network type quality scores (0-1) */
const NETWORK_SCORES: Record<string, number> = {
  'ethernet': 1.0,
  'wifi': 0.9,
  '5g': 0.8,
  '4g': 0.6,
  '3g': 0.3,
  '2g': 0.1,
  'unknown': 0.5,
};

/** Super node connection limit (vs 5 for regular peers) */
export const SUPER_NODE_MAX_CONNECTIONS = 15;
export const REGULAR_NODE_MAX_CONNECTIONS = 5;

export class SuperNodeElection {
  /**
   * Compute normalized score for a peer.
   * All components are normalized to 0-1, then weighted.
   */
  computeScore(peer: PeerScore, allPeers: PeerScore[]): number {
    // Normalize uptime
    const maxUptime = Math.max(...allPeers.map((p) => p.uptimeSeconds), 1);
    const uptimeNorm = Math.min(peer.uptimeSeconds / maxUptime, 1);

    // Normalize bandwidth
    const maxBw = Math.max(...allPeers.map((p) => p.bandwidthKbps), 1);
    const bwNorm = Math.min(peer.bandwidthKbps / maxBw, 1);

    // Normalize latency (inverse: lower is better)
    const maxLat = Math.max(...allPeers.map((p) => p.latencyMs), 1);
    const latNorm = 1 - Math.min(peer.latencyMs / maxLat, 1);

    // Battery
    const batteryNorm = peer.batteryLevel ?? 0.5;

    // NAT
    const natNorm = NAT_SCORES[peer.natType] ?? 0.2;

    // CPU cores: normalize against max in group (higher = better)
    const cores = allPeers.map((p) => p.cpuCores ?? 0);
    const maxCores = Math.max(...cores, 1);
    const cpuNorm = Math.min((peer.cpuCores ?? 0) / maxCores, 1);

    // Memory: normalize against max in group (higher = better)
    const mems = allPeers.map((p) => p.memoryGb ?? 0);
    const maxMem = Math.max(...mems, 1);
    const memNorm = Math.min((peer.memoryGb ?? 0) / maxMem, 1);

    // Network type
    const netNorm = NETWORK_SCORES[peer.networkType ?? 'unknown'] ?? 0.5;

    return (
      WEIGHTS.uptime * uptimeNorm +
      WEIGHTS.bandwidth * bwNorm +
      WEIGHTS.latency * latNorm +
      WEIGHTS.battery * batteryNorm +
      WEIGHTS.nat * natNorm +
      WEIGHTS.cpu * cpuNorm +
      WEIGHTS.memory * memNorm +
      WEIGHTS.network * netNorm
    );
  }

  /**
   * Elect super nodes from the given peer scores.
   * Returns a deterministic sorted list: score descending, then peerId ascending for tiebreak.
   *
   * @param peerScores All peers' self-reported scores
   * @param participantCount Total number of participants
   */
  elect(peerScores: PeerScore[], participantCount: number): ElectionResult {
    if (participantCount <= 20 || peerScores.length === 0) {
      return { superNodes: [], scores: new Map() };
    }

    // Compute scores
    const scored = peerScores.map((peer) => ({
      peerId: peer.peerId,
      score: this.computeScore(peer, peerScores),
    }));

    // Deterministic sort: score desc → peerId asc (tiebreak)
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
    });

    // Select top ceil(n/10) as super nodes
    const superNodeCount = Math.ceil(participantCount / 10);
    const superNodes = scored.slice(0, superNodeCount).map((s) => s.peerId);

    const scoresMap = new Map(scored.map((s) => [s.peerId, s.score]));

    return { superNodes, scores: scoresMap };
  }

  /**
   * Get the target connection limit for a peer.
   */
  getMaxConnections(peerId: string, superNodes: string[]): number {
    return superNodes.includes(peerId)
      ? SUPER_NODE_MAX_CONNECTIONS
      : REGULAR_NODE_MAX_CONNECTIONS;
  }

  /**
   * Check if a peer is a super node.
   */
  isSuperNode(peerId: string, superNodes: string[]): boolean {
    return superNodes.includes(peerId);
  }
}
