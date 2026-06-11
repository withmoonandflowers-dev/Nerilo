/**
 * Game Session — Lifecycle Management
 *
 * Manages the lifecycle of a P2P game session (lobby → playing → paused → ended).
 * Host migration uses deterministic election (lowest peerId wins) — zero network overhead.
 * Seed negotiation uses hash-then-reveal to prevent bias.
 *
 * Server-independent: once WebRTC connections are established, this operates
 * entirely over DataChannel without any server dependency.
 */

import type { SessionState, PeerState, PeerInfo, SerializedSessionState } from './types';
import { logger } from '../../../utils/logger';

export class GameSession {
  readonly sessionId: string;
  readonly createdAt: number;
  private hostPeerId: string;
  private peers: Map<string, PeerState> = new Map();
  private state: SessionState = 'lobby';
  private hostEpoch = 0;

  // Seed negotiation state
  private seedCommitments: Map<string, string> = new Map(); // peerId → commitHash
  private seedReveals: Map<string, number> = new Map();      // peerId → seedFragment
  private negotiatedSeed: number | null = null;

  // Event listeners
  private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  constructor(
    sessionId: string,
    private localPeerId: string,
    private maxPlayers: number,
    public readonly gameVersion: string,
    displayName?: string
  ) {
    this.sessionId = sessionId;
    this.createdAt = Date.now();
    this.hostPeerId = localPeerId;

    // Add self as first peer
    this.peers.set(localPeerId, {
      peerId: localPeerId,
      displayName,
      joinedAt: this.createdAt,
      isHost: true,
      isConnected: true,
      lastInputTick: 0,
      consecutiveDesyncs: 0,
    });
  }

  // ── State Queries ─────────────────────────────────────────────────

  getState(): SessionState { return this.state; }
  isHost(): boolean { return this.hostPeerId === this.localPeerId; }
  getHostPeerId(): string { return this.hostPeerId; }
  getHostEpoch(): number { return this.hostEpoch; }
  getSeed(): number | null { return this.negotiatedSeed; }

  getPeers(): PeerInfo[] {
    return [...this.peers.values()].map(({ peerId, displayName, joinedAt, isHost, isConnected }) =>
      ({ peerId, displayName, joinedAt, isHost, isConnected })
    );
  }

  getConnectedPeerIds(): string[] {
    return [...this.peers.values()].filter(p => p.isConnected).map(p => p.peerId);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  // ── Peer Lifecycle ────────────────────────────────────────────────

  addPeer(peerId: string, displayName?: string): boolean {
    if (this.peers.size >= this.maxPlayers) {
      logger.warn('[GameSession] Session full', { sessionId: this.sessionId, maxPlayers: this.maxPlayers });
      return false;
    }
    if (this.peers.has(peerId)) {
      // Re-connect existing peer
      const peer = this.peers.get(peerId)!;
      peer.isConnected = true;
      this.emit('peer:reconnected', peerId);
      return true;
    }

    this.peers.set(peerId, {
      peerId,
      displayName,
      joinedAt: Date.now(),
      isHost: false,
      isConnected: true,
      lastInputTick: 0,
      consecutiveDesyncs: 0,
    });
    this.emit('peer:joined', peerId);
    return true;
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.isConnected = false;
    this.emit('peer:left', peerId);

    // If the host left, trigger host migration
    if (peerId === this.hostPeerId) {
      this.handleHostDisconnect(peerId);
    }
  }

  // ── Host Migration ────────────────────────────────────────────────

  /**
   * Deterministic host election: lowest peerId among connected peers.
   * All peers compute the same result independently — zero network messages needed.
   */
  electNewHost(): string {
    const connected = this.getConnectedPeerIds().sort();
    return connected[0] || this.localPeerId;
  }

  handleHostDisconnect(disconnectedHostId: string): void {
    const newHost = this.electNewHost();
    const previousHost = this.hostPeerId;

    // Update host
    this.hostPeerId = newHost;
    this.hostEpoch++;

    // Update peer flags
    for (const [id, peer] of this.peers) {
      peer.isHost = id === newHost;
    }

    logger.info('[GameSession] Host migrated', {
      sessionId: this.sessionId,
      previousHost,
      newHost,
      epoch: this.hostEpoch,
    });

    this.emit('host:migrated', { newHost, previousHost: disconnectedHostId, epoch: this.hostEpoch });
  }

  // ── Session Control ───────────────────────────────────────────────

  startGame(seed: number): void {
    if (this.state !== 'lobby') return;
    this.state = 'playing';
    this.negotiatedSeed = seed;
    this.emit('game:started', seed);
  }

  pauseGame(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.emit('game:paused');
  }

  resumeGame(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.emit('game:resumed');
  }

  endGame(): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.emit('game:ended');
  }

  // ── Seed Negotiation (Hash-Then-Reveal) ───────────────────────────

  /**
   * Phase 1: Commit a hash of our seed fragment.
   * Returns the commitment hash for broadcasting.
   */
  async commitSeed(seedFragment: number): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(`nerilo-seed:${seedFragment}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const commitHash = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

    this.seedCommitments.set(this.localPeerId, commitHash);
    this.seedReveals.set(this.localPeerId, seedFragment);
    return commitHash;
  }

  /** Receive a peer's commitment */
  receiveCommitment(peerId: string, commitHash: string): void {
    this.seedCommitments.set(peerId, commitHash);
  }

  /**
   * Phase 2: Reveal and verify. Returns final XOR'd seed if all valid, null if cheating detected.
   */
  async receiveReveal(peerId: string, seedFragment: number): Promise<number | null> {
    // Verify commitment
    const expectedHash = this.seedCommitments.get(peerId);
    if (!expectedHash) return null;

    const encoder = new TextEncoder();
    const data = encoder.encode(`nerilo-seed:${seedFragment}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const actualHash = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

    if (actualHash !== expectedHash) {
      logger.warn('[GameSession] Seed commitment mismatch — potential cheating', { peerId });
      return null;
    }

    this.seedReveals.set(peerId, seedFragment);

    // Check if all peers have revealed
    const connected = this.getConnectedPeerIds();
    const allRevealed = connected.every(id => this.seedReveals.has(id));
    if (!allRevealed) return null;

    // Compute final seed: XOR of all fragments
    let finalSeed = 0;
    for (const fragment of this.seedReveals.values()) {
      finalSeed ^= fragment;
    }

    this.negotiatedSeed = finalSeed;
    return finalSeed;
  }

  // ── Serialization ─────────────────────────────────────────────────

  serialize(): SerializedSessionState {
    return {
      sessionId: this.sessionId,
      hostPeerId: this.hostPeerId,
      peers: this.getPeers(),
      state: this.state,
      createdAt: this.createdAt,
      rngSeed: this.negotiatedSeed ?? 0,
    };
  }

  static deserialize(data: SerializedSessionState, localPeerId: string): GameSession {
    const session = new GameSession(
      data.sessionId, localPeerId, 8, '1.0.0'
    );
    session.hostPeerId = data.hostPeerId;
    session.state = data.state;
    session.negotiatedSeed = data.rngSeed;
    for (const peer of data.peers) {
      session.peers.set(peer.peerId, {
        ...peer,
        lastInputTick: 0,
        consecutiveDesyncs: 0,
      });
    }
    return session;
  }

  // ── Event Emitter ─────────────────────────────────────────────────

  on(event: string, handler: (...args: unknown[]) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach(fn => fn(...args));
  }

  destroy(): void {
    this.listeners.clear();
    this.peers.clear();
  }
}
