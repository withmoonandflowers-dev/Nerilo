/**
 * Game Feature Module — FeatureModule Implementation
 *
 * Follows the same plugin pattern as ChatFeature.
 * Registers under namespace 'game' and handles all game-related envelope types.
 * Runtime payload validation prevents malicious peers from injecting bad data.
 */

import type { FeatureModule, FeatureContext, Envelope } from '../../../types';
import {
  GameMsgType,
  isValidGameInput,
  isValidStateHash,
  isValidSeedCommit,
  isValidSeedReveal,
  isValidSessionJoin,
  type GameInputPayload,
  type StateHashPayload,
  type SeedCommitPayload,
  type SeedRevealPayload,
  type SessionJoinPayload,
  type SessionLeavePayload,
  type HostMigratedPayload,
  type SnapshotRequestPayload,
  type GameStartPayload,
  type GameControlPayload,
} from './GameMessageTypes';

// ── Callback Types ──────────────────────────────────────────────────────────

export interface GameFeatureCallbacks {
  onInput?: (payload: GameInputPayload) => void;
  onStateHash?: (payload: StateHashPayload) => void;
  onSeedCommit?: (payload: SeedCommitPayload) => void;
  onSeedReveal?: (payload: SeedRevealPayload) => void;
  onSessionJoin?: (payload: SessionJoinPayload) => void;
  onSessionLeave?: (payload: SessionLeavePayload) => void;
  onHostMigrated?: (payload: HostMigratedPayload) => void;
  onSnapshotRequest?: (payload: SnapshotRequestPayload) => void;
  onSnapshotResponse?: (payload: unknown) => void;
  onGameStart?: (payload: GameStartPayload) => void;
  onGamePause?: (payload: GameControlPayload) => void;
  onGameResume?: (payload: GameControlPayload) => void;
  onGameEnd?: (payload: GameControlPayload) => void;
}

// ── Module State ────────────────────────────────────────────────────────────

let _ctx: FeatureContext | null = null;
let _callbacks: GameFeatureCallbacks = {};

/** Set callbacks (called by GameTransportSDK during setup) */
export function setGameFeatureCallbacks(cb: GameFeatureCallbacks): void {
  _callbacks = cb;
}

// ── Feature Module ──────────────────────────────────────────────────────────

export const GameFeature: FeatureModule = {
  name: 'game',
  version: '1.0.0',
  namespaces: ['game'],
  capabilities: [
    'game:input', 'game:state', 'game:session',
    'game:hash', 'game:seed', 'game:snapshot',
  ],

  async setup(ctx: FeatureContext): Promise<void> {
    _ctx = ctx;
    ctx.logger.info('[GameFeature] setup complete', { selfId: ctx.selfId, roomId: ctx.roomId });
  },

  async teardown(): Promise<void> {
    _ctx = null;
    _callbacks = {};
  },

  async onPeerJoin(peerId: string): Promise<void> {
    _ctx?.logger.info('[GameFeature] peer joined', { peerId });
  },

  async onPeerLeave(peerId: string): Promise<void> {
    _ctx?.logger.info('[GameFeature] peer left', { peerId });
    _callbacks.onSessionLeave?.({ peerId, reason: 'disconnect' });
  },

  async handleEnvelope(env: Envelope): Promise<void> {
    if (!_ctx) return;

    switch (env.type) {
      case GameMsgType.INPUT: {
        if (!isValidGameInput(env.payload)) {
          _ctx.logger.warn('[GameFeature] Invalid INPUT payload', { from: env.from });
          return;
        }
        _callbacks.onInput?.(env.payload);
        break;
      }

      case GameMsgType.STATE_HASH: {
        if (!isValidStateHash(env.payload)) {
          _ctx.logger.warn('[GameFeature] Invalid STATE_HASH payload', { from: env.from });
          return;
        }
        _callbacks.onStateHash?.(env.payload);
        break;
      }

      case GameMsgType.SEED_COMMIT: {
        if (!isValidSeedCommit(env.payload)) {
          _ctx.logger.warn('[GameFeature] Invalid SEED_COMMIT payload', { from: env.from });
          return;
        }
        _callbacks.onSeedCommit?.(env.payload);
        break;
      }

      case GameMsgType.SEED_REVEAL: {
        if (!isValidSeedReveal(env.payload)) {
          _ctx.logger.warn('[GameFeature] Invalid SEED_REVEAL payload', { from: env.from });
          return;
        }
        _callbacks.onSeedReveal?.(env.payload);
        break;
      }

      case GameMsgType.SESSION_JOIN: {
        if (!isValidSessionJoin(env.payload)) {
          _ctx.logger.warn('[GameFeature] Invalid SESSION_JOIN payload', { from: env.from });
          return;
        }
        _callbacks.onSessionJoin?.(env.payload);
        break;
      }

      case GameMsgType.SESSION_LEAVE: {
        _callbacks.onSessionLeave?.(env.payload as SessionLeavePayload);
        break;
      }

      case GameMsgType.HOST_MIGRATED: {
        _callbacks.onHostMigrated?.(env.payload as HostMigratedPayload);
        break;
      }

      case GameMsgType.SNAPSHOT_REQUEST: {
        _callbacks.onSnapshotRequest?.(env.payload as SnapshotRequestPayload);
        break;
      }

      case GameMsgType.SNAPSHOT_RESPONSE: {
        _callbacks.onSnapshotResponse?.(env.payload);
        break;
      }

      case GameMsgType.GAME_START: {
        _callbacks.onGameStart?.(env.payload as GameStartPayload);
        break;
      }

      case GameMsgType.GAME_PAUSE: {
        _callbacks.onGamePause?.(env.payload as GameControlPayload);
        break;
      }

      case GameMsgType.GAME_RESUME: {
        _callbacks.onGameResume?.(env.payload as GameControlPayload);
        break;
      }

      case GameMsgType.GAME_END: {
        _callbacks.onGameEnd?.(env.payload as GameControlPayload);
        break;
      }

      default:
        break;
    }
  },
};
