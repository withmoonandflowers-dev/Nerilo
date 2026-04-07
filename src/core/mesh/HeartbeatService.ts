/**
 * Peer Heartbeat 協議
 * 每 30 秒向所有鄰居發送 ping，偵測 peer 斷線並測量延遲 (RTT)
 */

import { logger } from '../../utils/logger';

export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor';

export interface PeerLatencyInfo {
  peerId: string;
  rttMs: number | null;
  quality: ConnectionQuality;
  reachable: boolean;
  missedPings: number;
  lastPongAt: number | null;
}

/** Callback when a peer is determined unreachable */
export type UnreachableHandler = (peerId: string) => void;

/** Ping message sent on control channel */
export interface PingMessage {
  type: 'system:ping';
  timestamp: number;
  senderId: string;
}

/** Pong response message */
export interface PongMessage {
  type: 'system:pong';
  /** Original ping timestamp (for RTT calculation) */
  pingTimestamp: number;
  senderId: string;
}

const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 3;

export class HeartbeatService {
  private peerState = new Map<
    string,
    { rttMs: number | null; missedPings: number; lastPongAt: number | null }
  >();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private unreachableHandlers: UnreachableHandler[] = [];
  private sendPing: ((peerId: string, msg: PingMessage) => void) | null = null;

  constructor(private readonly localId: string) {}

  /**
   * Register the function used to send ping messages over the control channel.
   */
  setSendFunction(fn: (peerId: string, msg: PingMessage) => void): void {
    this.sendPing = fn;
  }

  /**
   * Register a handler for when a peer becomes unreachable.
   */
  onUnreachable(handler: UnreachableHandler): () => void {
    this.unreachableHandlers.push(handler);
    return () => {
      this.unreachableHandlers = this.unreachableHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Start sending heartbeats to all known peers.
   * @param getPeerIds Function that returns current connected peer IDs
   */
  start(getPeerIds: () => string[]): void {
    if (this.pingTimer) return;

    this.pingTimer = setInterval(() => {
      const peers = getPeerIds();
      for (const peerId of peers) {
        this.sendPingTo(peerId);
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Stop heartbeat service.
   */
  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.peerState.clear();
  }

  /**
   * Send a ping to a specific peer.
   */
  private sendPingTo(peerId: string): void {
    if (!this.sendPing) return;

    // Initialize state if needed
    if (!this.peerState.has(peerId)) {
      this.peerState.set(peerId, { rttMs: null, missedPings: 0, lastPongAt: null });
    }

    const state = this.peerState.get(peerId)!;
    state.missedPings++;

    // Check for unreachable
    if (state.missedPings >= MAX_MISSED_PINGS) {
      this.notifyUnreachable(peerId);
    }

    const ping: PingMessage = {
      type: 'system:ping',
      timestamp: Date.now(),
      senderId: this.localId,
    };

    try {
      this.sendPing(peerId, ping);
    } catch {
      // Peer may already be disconnected
    }
  }

  /**
   * Handle an incoming pong message. Call this when a pong is received from control channel.
   */
  handlePong(pong: PongMessage, fromPeerId: string): void {
    const rtt = Date.now() - pong.pingTimestamp;

    if (!this.peerState.has(fromPeerId)) {
      this.peerState.set(fromPeerId, { rttMs: null, missedPings: 0, lastPongAt: null });
    }

    const state = this.peerState.get(fromPeerId)!;
    state.rttMs = rtt;
    state.missedPings = 0;
    state.lastPongAt = Date.now();
  }

  /**
   * Build a pong response from a received ping.
   */
  static createPong(ping: PingMessage, localId: string): PongMessage {
    return {
      type: 'system:pong',
      pingTimestamp: ping.timestamp,
      senderId: localId,
    };
  }

  /**
   * Register a new peer (e.g. when a neighbor is connected).
   */
  addPeer(peerId: string): void {
    if (!this.peerState.has(peerId)) {
      this.peerState.set(peerId, { rttMs: null, missedPings: 0, lastPongAt: null });
    }
  }

  /**
   * Remove a peer (e.g. when disconnected).
   */
  removePeer(peerId: string): void {
    this.peerState.delete(peerId);
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────

  getLatency(peerId: string): number | null {
    return this.peerState.get(peerId)?.rttMs ?? null;
  }

  getConnectionQuality(peerId: string): ConnectionQuality {
    const rtt = this.getLatency(peerId);
    if (rtt === null) return 'poor';
    if (rtt < 100) return 'excellent';
    if (rtt < 300) return 'good';
    if (rtt < 1000) return 'fair';
    return 'poor';
  }

  isReachable(peerId: string): boolean {
    const state = this.peerState.get(peerId);
    if (!state) return false;
    return state.missedPings < MAX_MISSED_PINGS;
  }

  getAllPeerInfo(): PeerLatencyInfo[] {
    const result: PeerLatencyInfo[] = [];
    for (const [peerId, state] of this.peerState) {
      result.push({
        peerId,
        rttMs: state.rttMs,
        quality: this.getConnectionQuality(peerId),
        reachable: state.missedPings < MAX_MISSED_PINGS,
        missedPings: state.missedPings,
        lastPongAt: state.lastPongAt,
      });
    }
    return result;
  }

  private notifyUnreachable(peerId: string): void {
    for (const handler of this.unreachableHandlers) {
      try {
        handler(peerId);
      } catch (err) {
        logger.error('[HeartbeatService] Unreachable handler error', err);
      }
    }
  }
}
