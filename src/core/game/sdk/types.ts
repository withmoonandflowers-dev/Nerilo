/**
 * Game Transport SDK — Type Definitions
 *
 * Core types for the server-independent game transport layer.
 * Games built on this SDK continue to work even if the publisher shuts down,
 * because all game state synchronization is peer-to-peer.
 */

import type { WorldSnapshot } from '../types';

// ── Session ─────────────────────────────────────────────────────────────────

export type SessionState = 'lobby' | 'playing' | 'paused' | 'ended';

export interface PeerInfo {
  peerId: string;
  displayName?: string;
  joinedAt: number;
  isHost: boolean;
  isConnected: boolean;
}

export interface PeerState extends PeerInfo {
  lastInputTick: number;
  consecutiveDesyncs: number;
}

export interface GameSessionConfig {
  /** Auto-generated UUID if omitted */
  sessionId?: string;
  maxPlayers: number;
  gameVersion: string;
  displayName?: string;
  tickRate?: number;
}

export interface SerializedSessionState {
  sessionId: string;
  hostPeerId: string;
  peers: PeerInfo[];
  state: SessionState;
  createdAt: number;
  rngSeed: number;
}

// ── SDK Config ──────────────────────────────────────────────────────────────

export interface GameTransportSDKConfig {
  localPeerId: string;
  /** Tick rate in Hz (default: 20) */
  tickRate?: number;
  /** Max players per session (default: 8) */
  maxPlayers?: number;
  /** Input delay in ticks (default: 2) */
  inputDelay?: number;
  /** Max ticks ahead of confirmed before pausing (default: 8) */
  maxPredictionAhead?: number;
  /** Ticks between state hash validation (default: 20) */
  validationInterval?: number;
  /** IndexedDB namespace for persistence (default: 'game') */
  persistenceKey?: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type GameSDKEvent =
  | 'session:created'
  | 'session:joined'
  | 'session:left'
  | 'session:destroyed'
  | 'peer:joined'
  | 'peer:left'
  | 'host:migrated'
  | 'game:started'
  | 'game:paused'
  | 'game:resumed'
  | 'game:ended'
  | 'sync:rollback'
  | 'sync:desync'
  | 'sync:desync-alert'
  | 'state:saved'
  | 'state:loaded';

// ── RNG State ───────────────────────────────────────────────────────────────

export interface RNGState {
  seed: number;
  callCount: number;
}

// ── Snapshot Bundle ─────────────────────────────────────────────────────────

export interface GameSnapshotBundle {
  tick: number;
  snapshot: WorldSnapshot;
  rngState: RNGState;
  sessionState: SerializedSessionState;
}
