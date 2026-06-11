/**
 * Game State Store — IndexedDB Persistence
 *
 * Persists game snapshots, RNG state, and session metadata to IndexedDB.
 * Enables offline resilience: players can reconnect and resume from
 * the last confirmed state without any server involvement.
 */

import type { WorldSnapshot } from '../types';
import type { RNGState, SerializedSessionState } from './types';
import { logger } from '../../../utils/logger';

/** Minimal storage interface (matches IndexedDBService.featureState) */
export interface IGameStateStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export class GameStateStore {
  private prefix: string;

  constructor(
    private storage: IGameStateStorage,
    sessionId: string
  ) {
    this.prefix = `game:${sessionId}`;
  }

  // ── Snapshot ───────────────────────────────────────────────────────

  async saveSnapshot(tick: number, snapshot: WorldSnapshot): Promise<void> {
    await this.storage.set(`${this.prefix}:snapshot`, { tick, snapshot, savedAt: Date.now() });
    logger.info('[GameStateStore] Snapshot saved', { tick });
  }

  async loadLatestSnapshot(): Promise<{ tick: number; snapshot: WorldSnapshot } | null> {
    const data = await this.storage.get(`${this.prefix}:snapshot`) as { tick: number; snapshot: WorldSnapshot } | null;
    return data || null;
  }

  // ── RNG State ─────────────────────────────────────────────────────

  async saveRNGState(state: RNGState): Promise<void> {
    await this.storage.set(`${this.prefix}:rng`, state);
  }

  async loadRNGState(): Promise<RNGState | null> {
    const data = await this.storage.get(`${this.prefix}:rng`) as RNGState | null;
    return data || null;
  }

  // ── Session Metadata ──────────────────────────────────────────────

  async saveSessionMeta(meta: SerializedSessionState): Promise<void> {
    await this.storage.set(`${this.prefix}:session`, meta);
  }

  async loadSessionMeta(): Promise<SerializedSessionState | null> {
    const data = await this.storage.get(`${this.prefix}:session`) as SerializedSessionState | null;
    return data || null;
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  async clear(): Promise<void> {
    await Promise.all([
      this.storage.delete(`${this.prefix}:snapshot`),
      this.storage.delete(`${this.prefix}:rng`),
      this.storage.delete(`${this.prefix}:session`),
    ]);
    logger.info('[GameStateStore] Cleared all state', { prefix: this.prefix });
  }
}
