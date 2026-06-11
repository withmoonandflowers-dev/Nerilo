/**
 * Game Transport SDK — Unified Public API
 *
 * The single entry point for game developers. Orchestrates all subsystems:
 * World (ECS), GameLoop, InputBuffer, NetworkSyncManager, GameStateValidator,
 * DeterministicRNG, GameSession, GameFeature, and GameStateStore.
 *
 * Server-independent: once WebRTC DataChannel is established, this SDK
 * operates entirely over P2P. Firebase can be shut down and the game continues.
 *
 * Usage:
 * ```ts
 * const sdk = new GameTransportSDK(config);
 * const session = await sdk.createSession({ maxPlayers: 4, gameVersion: '1.0' });
 *
 * // Register ECS systems
 * sdk.registerSystem(new PhysicsSystem());
 * sdk.registerSystem(new RenderSystem());
 *
 * // Start game loop
 * sdk.start();
 *
 * // Submit input each frame
 * sdk.submitLocalInput(['jump', 'shoot'], { moveX: 0.5 });
 * ```
 */

import type { GameTransportSDKConfig, GameSDKEvent, GameSessionConfig } from './types';
import type { System, EntityId, PlayerInput } from '../types';
import { World } from '../World';
import { GameLoop } from '../GameLoop';
import { InputBuffer } from '../InputBuffer';
import { NetworkSyncManager } from '../NetworkSyncManager';
import { GameStateValidator } from '../GameStateValidator';
import { GameSession } from './GameSession';
import { DeterministicRNG } from './DeterministicRNG';
import { GameStateStore, type IGameStateStorage } from './GameStateStore';
import { GameFeature, setGameFeatureCallbacks } from './GameFeature';
import { GameMsgType } from './GameMessageTypes';
import { logger } from '../../../utils/logger';
import { generateUUID } from '../../../utils/uuid';

/** Minimal broadcast interface — matches FeatureContext.broadcast */
export interface IGameBroadcast {
  broadcast(envelope: unknown): Promise<void>;
  send(peerId: string, envelope: unknown): Promise<void>;
}

export class GameTransportSDK {
  // Subsystems
  private world: World;
  /** Kept for tick rate config; SDK drives its own rAF loop via syncManager */
  public readonly gameLoop: GameLoop;
  private inputBuffer: InputBuffer;
  private syncManager: NetworkSyncManager;
  private validator: GameStateValidator;
  private session: GameSession | null = null;
  private rng: DeterministicRNG | null = null;
  private stateStore: GameStateStore | null = null;

  // Config
  private readonly config: Required<GameTransportSDKConfig>;
  private readonly localPeerId: string;

  // Communication (injected)
  private broadcaster: IGameBroadcast | null = null;

  // Event listeners
  private eventListeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  // Tick loop control
  private running = false;
  private animFrameId: number | null = null;
  private lastTimestamp = 0;
  private accumulator = 0;
  private persistCounter = 0;
  private static readonly PERSIST_INTERVAL = 100; // Save every 100 confirmed ticks

  constructor(config: GameTransportSDKConfig) {
    this.config = {
      localPeerId: config.localPeerId,
      tickRate: config.tickRate ?? 20,
      maxPlayers: config.maxPlayers ?? 8,
      inputDelay: config.inputDelay ?? 2,
      maxPredictionAhead: config.maxPredictionAhead ?? 8,
      validationInterval: config.validationInterval ?? 20,
      persistenceKey: config.persistenceKey ?? 'game',
    };
    this.localPeerId = config.localPeerId;

    // Initialize subsystems
    this.world = new World();
    this.gameLoop = new GameLoop(this.world, { tickRate: this.config.tickRate });
    this.inputBuffer = new InputBuffer({
      inputDelay: this.config.inputDelay,
    });
    this.syncManager = new NetworkSyncManager(this.world, this.inputBuffer, {
      maxPredictionAhead: this.config.maxPredictionAhead,
    });
    this.validator = new GameStateValidator(this.localPeerId, {
      validationInterval: this.config.validationInterval,
    });

    // Wire validator desync events
    this.validator.onDesync((_event) => this.emit('sync:desync'));
    this.validator.onDesyncAlert((_peerId) => this.emit('sync:desync-alert'));
  }

  // ── Session Management ────────────────────────────────────────────

  async createSession(sessionConfig: GameSessionConfig): Promise<GameSession> {
    const sessionId = sessionConfig.sessionId ?? generateUUID();
    this.session = new GameSession(
      sessionId,
      this.localPeerId,
      sessionConfig.maxPlayers,
      sessionConfig.gameVersion,
      sessionConfig.displayName
    );
    this.emit('session:created', sessionId);
    logger.info('[GameTransportSDK] Session created', { sessionId });
    return this.session;
  }

  getSession(): GameSession | null {
    return this.session;
  }

  async leaveSession(): Promise<void> {
    if (this.session) {
      this.stop();
      this.session.destroy();
      this.session = null;
    }
    this.emit('session:left');
  }

  // ── Communication ─────────────────────────────────────────────────

  /** Set the broadcast/send interface (from FeatureContext or direct) */
  setBroadcaster(broadcaster: IGameBroadcast): void {
    this.broadcaster = broadcaster;
  }

  /** Set the storage backend for state persistence */
  setStorage(storage: IGameStateStorage, sessionId: string): void {
    this.stateStore = new GameStateStore(storage, sessionId);
  }

  /** Get the GameFeature module for FeatureRegistry registration */
  getFeatureModule(): typeof GameFeature {
    // Wire callbacks to this SDK instance
    setGameFeatureCallbacks({
      onInput: (payload) => {
        this.inputBuffer.addRemoteInput({
          peerId: payload.peerId,
          tick: payload.tick,
          actions: payload.actions,
          axes: payload.axes,
          seq: payload.seq,
        });
        this.syncManager.onRemoteInputReceived({
          peerId: payload.peerId,
          tick: payload.tick,
          actions: payload.actions,
          axes: payload.axes,
          seq: payload.seq,
        });
      },
      onStateHash: (payload) => {
        this.validator.submitHash(payload.tick, payload.peerId, payload.hash);
      },
      onSeedCommit: (payload) => {
        this.session?.receiveCommitment(payload.peerId, payload.commitHash);
      },
      onSeedReveal: async (payload) => {
        const seed = await this.session?.receiveReveal(payload.peerId, payload.seedFragment);
        if (seed !== null && seed !== undefined) {
          this.rng = new DeterministicRNG(seed);
          logger.info('[GameTransportSDK] Seed negotiated', { seed });
        }
      },
      onSessionJoin: (payload) => {
        this.session?.addPeer(payload.peerId, payload.displayName);
        this.emit('peer:joined', payload.peerId);
      },
      onSessionLeave: (payload) => {
        this.session?.removePeer(payload.peerId);
        this.emit('peer:left', payload.peerId);
      },
      onHostMigrated: (payload) => {
        this.emit('host:migrated', payload);
      },
      onGameStart: (payload) => {
        this.rng = new DeterministicRNG(payload.seed);
        this.session?.startGame(payload.seed);
        this.emit('game:started', payload);
      },
    });
    return GameFeature;
  }

  // ── ECS Access ────────────────────────────────────────────────────

  getWorld(): World { return this.world; }

  createEntity(tag?: string): EntityId {
    return this.world.createEntity(tag);
  }

  destroyEntity(id: EntityId): void {
    this.world.destroyEntity(id);
  }

  addComponent<T extends Record<string, unknown>>(entity: EntityId, type: string, data: T): void {
    this.world.addComponent(entity, type, data);
  }

  getComponent<T>(entity: EntityId, type: string): T | undefined {
    return this.world.getComponent(entity, type) as T | undefined;
  }

  query(...types: string[]): EntityId[] {
    return this.world.query(...types);
  }

  // ── Systems ───────────────────────────────────────────────────────

  registerSystem(system: System): void {
    this.world.registerSystem(system);
  }

  removeSystem(name: string): void {
    this.world.removeSystem(name);
  }

  // ── Input ─────────────────────────────────────────────────────────

  submitLocalInput(actions: string[] = [], axes: Record<string, number> = {}): PlayerInput {
    const input = this.inputBuffer.addLocalInput(
      this.localPeerId,
      this.world.getCurrentTick(),
      actions,
      axes
    );

    // Broadcast to peers
    if (this.broadcaster) {
      this.broadcaster.broadcast({
        v: 1, ns: 'game', type: GameMsgType.INPUT,
        id: generateUUID(), ts: Date.now(), from: this.localPeerId,
        payload: {
          peerId: this.localPeerId,
          tick: input.tick,
          actions: input.actions,
          axes: input.axes,
          seq: input.seq,
        },
      }).catch(() => {});
    }

    return input;
  }

  // ── Game Loop ─────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimestamp = performance.now();
    this.accumulator = 0;
    this.tick();
    logger.info('[GameTransportSDK] Game loop started', { tickRate: this.config.tickRate });
  }

  stop(): void {
    this.running = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  isRunning(): boolean { return this.running; }
  getCurrentTick(): number { return this.world.getCurrentTick(); }

  private tick(): void {
    if (!this.running) return;

    const now = performance.now();
    const dt = (now - this.lastTimestamp) / 1000;
    this.lastTimestamp = now;

    const tickDuration = 1 / this.config.tickRate;
    this.accumulator += Math.min(dt, 0.25); // Cap to prevent spiral of death

    let ticksThisFrame = 0;
    const maxTicksPerFrame = 5;

    while (this.accumulator >= tickDuration && ticksThisFrame < maxTicksPerFrame) {
      // Advance through NetworkSyncManager (lockstep + rollback)
      this.syncManager.advanceTick(tickDuration);
      this.accumulator -= tickDuration;
      ticksThisFrame++;

      const tick = this.world.getCurrentTick();

      // State hash validation
      if (this.validator.shouldValidate(tick)) {
        const hash = this.syncManager.getStateHash(tick);
        if (hash && this.broadcaster) {
          this.broadcaster.broadcast({
            v: 1, ns: 'game', type: GameMsgType.STATE_HASH,
            id: generateUUID(), ts: Date.now(), from: this.localPeerId,
            payload: { tick, hash, peerId: this.localPeerId },
          }).catch(() => {});
        }
      }

      // Periodic state persistence
      this.persistCounter++;
      if (this.persistCounter >= GameTransportSDK.PERSIST_INTERVAL && this.stateStore) {
        this.persistCounter = 0;
        this.saveState().catch(() => {});
      }
    }

    this.animFrameId = requestAnimationFrame(() => this.tick());
  }

  // ── RNG ───────────────────────────────────────────────────────────

  getRNG(): DeterministicRNG | null { return this.rng; }
  random(): number { return this.rng?.next() ?? Math.random(); }
  randomInt(min: number, max: number): number { return this.rng?.nextInt(min, max) ?? Math.floor(Math.random() * (max - min + 1)) + min; }

  /** Initialize RNG with a specific seed (for host-started games) */
  initRNG(seed: number): void {
    this.rng = new DeterministicRNG(seed);
  }

  // ── State Persistence ─────────────────────────────────────────────

  async saveState(): Promise<void> {
    if (!this.stateStore) return;
    const snapshot = this.world.takeSnapshot();
    await this.stateStore.saveSnapshot(this.world.getCurrentTick(), snapshot);
    if (this.rng) {
      await this.stateStore.saveRNGState(this.rng.getState());
    }
    if (this.session) {
      await this.stateStore.saveSessionMeta(this.session.serialize());
    }
    this.emit('state:saved');
  }

  async loadState(): Promise<boolean> {
    if (!this.stateStore) return false;

    const [snapshotData, rngState, sessionMeta] = await Promise.all([
      this.stateStore.loadLatestSnapshot(),
      this.stateStore.loadRNGState(),
      this.stateStore.loadSessionMeta(),
    ]);

    if (!snapshotData) return false;

    this.world.restoreSnapshot(snapshotData.snapshot);
    if (rngState) {
      this.rng = DeterministicRNG.fromState(rngState);
    }
    if (sessionMeta) {
      this.session = GameSession.deserialize(sessionMeta, this.localPeerId);
    }

    this.emit('state:loaded');
    logger.info('[GameTransportSDK] State loaded from IndexedDB', { tick: snapshotData.tick });
    return true;
  }

  // ── Sync Status ───────────────────────────────────────────────────

  getSyncStatus() {
    return this.syncManager.getSyncStatus();
  }

  getValidator(): GameStateValidator {
    return this.validator;
  }

  // ── Events ────────────────────────────────────────────────────────

  on(event: GameSDKEvent | string, handler: (...args: unknown[]) => void): () => void {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(handler);
    return () => this.eventListeners.get(event)?.delete(handler);
  }

  private emit(event: string, ...args: unknown[]): void {
    this.eventListeners.get(event)?.forEach(fn => fn(...args));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    this.stop();
    this.session?.destroy();
    this.eventListeners.clear();
    await GameFeature.teardown();
    logger.info('[GameTransportSDK] Destroyed');
  }
}
