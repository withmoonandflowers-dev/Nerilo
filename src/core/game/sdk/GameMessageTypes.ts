/**
 * Game Transport SDK — Protocol Message Types
 *
 * Defines all message types exchanged between peers during a game session.
 * All messages travel over WebRTC DataChannel (control channel for inputs,
 * bulk channel for snapshots).
 */

import type { WorldSnapshot } from '../types';
import type { SerializedSessionState, RNGState } from './types';

// ── Message Type Constants ──────────────────────────────────────────────────

export const GameMsgType = {
  // Input synchronization
  INPUT: 'game:INPUT',
  STATE_HASH: 'game:STATE_HASH',

  // Seed negotiation (hash-then-reveal)
  SEED_COMMIT: 'game:SEED_COMMIT',
  SEED_REVEAL: 'game:SEED_REVEAL',

  // Session lifecycle
  SESSION_JOIN: 'game:SESSION_JOIN',
  SESSION_LEAVE: 'game:SESSION_LEAVE',
  HOST_MIGRATED: 'game:HOST_MIGRATED',

  // Late-joiner sync
  SNAPSHOT_REQUEST: 'game:SNAPSHOT_REQUEST',
  SNAPSHOT_RESPONSE: 'game:SNAPSHOT_RESPONSE',

  // Game control
  GAME_START: 'game:GAME_START',
  GAME_PAUSE: 'game:GAME_PAUSE',
  GAME_RESUME: 'game:GAME_RESUME',
  GAME_END: 'game:GAME_END',
} as const;

export type GameMsgTypeValue = typeof GameMsgType[keyof typeof GameMsgType];

// ── Payload Interfaces ──────────────────────────────────────────────────────

/** Player input for a specific tick */
export interface GameInputPayload {
  peerId: string;
  tick: number;
  actions: string[];
  axes: Record<string, number>;
  seq: number;
}

/** State hash for cross-peer validation */
export interface StateHashPayload {
  tick: number;
  hash: string;
  peerId: string;
}

/** Seed commitment (phase 1 of hash-then-reveal) */
export interface SeedCommitPayload {
  peerId: string;
  /** SHA-256 hex of the seed fragment */
  commitHash: string;
}

/** Seed reveal (phase 2 of hash-then-reveal) */
export interface SeedRevealPayload {
  peerId: string;
  /** The actual seed value */
  seedFragment: number;
}

/** Peer joining a session */
export interface SessionJoinPayload {
  peerId: string;
  displayName?: string;
  gameVersion: string;
}

/** Peer leaving a session */
export interface SessionLeavePayload {
  peerId: string;
  reason?: string;
}

/** Host migration notification */
export interface HostMigratedPayload {
  newHostId: string;
  previousHostId: string;
  epoch: number;
}

/** Late-joiner requesting world snapshot */
export interface SnapshotRequestPayload {
  peerId: string;
  /** Tick the requester has (0 if fresh join) */
  fromTick: number;
}

/** World snapshot response for late joiners */
export interface SnapshotResponsePayload {
  tick: number;
  snapshot: WorldSnapshot;
  rngState: RNGState;
  sessionState: SerializedSessionState;
}

/** Game start signal (from host) */
export interface GameStartPayload {
  hostId: string;
  startTick: number;
  seed: number;
}

/** Game control (pause/resume/end) */
export interface GameControlPayload {
  fromId: string;
  reason?: string;
}

// ── Payload Validators ──────────────────────────────────────────────────────

export function isValidGameInput(p: unknown): p is GameInputPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.peerId === 'string' && typeof o.tick === 'number' && Array.isArray(o.actions) && typeof o.seq === 'number';
}

export function isValidStateHash(p: unknown): p is StateHashPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.tick === 'number' && typeof o.hash === 'string' && typeof o.peerId === 'string';
}

export function isValidSeedCommit(p: unknown): p is SeedCommitPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.peerId === 'string' && typeof o.commitHash === 'string';
}

export function isValidSeedReveal(p: unknown): p is SeedRevealPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.peerId === 'string' && typeof o.seedFragment === 'number';
}

export function isValidSessionJoin(p: unknown): p is SessionJoinPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.peerId === 'string' && typeof o.gameVersion === 'string';
}
