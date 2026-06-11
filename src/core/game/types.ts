/**
 * Game Engine — Type Definitions
 *
 * Foundational types for the P2P real-time game engine.
 * Designed for deterministic lockstep simulation over WebRTC DataChannel.
 *
 * Architecture:
 *   - Entity Component System (ECS) for game state
 *   - Fixed-timestep GameLoop for deterministic updates
 *   - Input buffer + rollback for network sync (Phase 2)
 */

// ── Entity ──────────────────────────────────────────────────────────────────

/** Unique identifier for an entity. Monotonically increasing within a World. */
export type EntityId = number;

/** Entity metadata. The entity itself is just an ID; data lives in components. */
export interface EntityMeta {
  /** Unique entity ID */
  id: EntityId;
  /** Human-readable tag for debugging (e.g., 'player', 'bullet', 'obstacle') */
  tag?: string;
  /** Owner peer ID (who controls this entity) */
  owner?: string;
  /** Whether this entity is active (inactive entities are skipped by systems) */
  active: boolean;
  /** Tick when this entity was created */
  createdAt: number;
  /** Tick when this entity was destroyed (0 = alive) */
  destroyedAt: number;
}

// ── Component ───────────────────────────────────────────────────────────────

/**
 * A component is a plain data object attached to an entity.
 * Components have NO behavior — that lives in Systems.
 *
 * Every component type has a unique string name used as a key.
 * Components must be serializable (no functions, no class instances).
 */
export type ComponentType = string;

/** Base constraint for component data: must be a plain object */
export type ComponentData = Record<string, unknown>;

/** Built-in component: 2D position */
export interface PositionComponent {
  x: number;
  y: number;
}

/** Built-in component: 2D velocity */
export interface VelocityComponent {
  vx: number;
  vy: number;
}

/** Built-in component: health points */
export interface HealthComponent {
  current: number;
  max: number;
}

/** Built-in component: sprite / visual representation */
export interface SpriteComponent {
  spriteId: string;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
}

/** Built-in component: 2D AABB collision box */
export interface ColliderComponent {
  width: number;
  height: number;
  /** Offset from entity position */
  offsetX: number;
  offsetY: number;
  /** Collision layer (bitmask) */
  layer: number;
  /** Collision mask — which layers this collider interacts with */
  mask: number;
}

/** Built-in component: player input state */
export interface InputComponent {
  /** Currently pressed keys / buttons */
  actions: Set<string>;
  /** Analog axes (e.g., joystick X/Y) */
  axes: Record<string, number>;
}

/** Built-in component: network ownership */
export interface NetworkComponent {
  /** Peer ID of the authoritative owner */
  ownerId: string;
  /** Last confirmed tick from the owner */
  lastConfirmedTick: number;
  /** Whether this entity is locally predicted (not yet confirmed by owner) */
  predicted: boolean;
}

// ── System ──────────────────────────────────────────────────────────────────

/**
 * A system processes entities that have a specific set of components.
 * Systems contain all behavior/logic — components are pure data.
 *
 * Systems run in a defined order each tick.
 */
export interface System {
  /** Unique system name (used for ordering and debugging) */
  readonly name: string;

  /** Component types this system requires on an entity to process it */
  readonly requiredComponents: readonly ComponentType[];

  /**
   * Priority for execution ordering (lower = runs first).
   * Default priority is 0. Use negative for early systems (input),
   * positive for late systems (render).
   */
  readonly priority: number;

  /**
   * Called once when the system is registered with the World.
   * Use for one-time setup.
   */
  init?(world: GameWorld): void;

  /**
   * Called every tick for each entity matching requiredComponents.
   * @param entities Array of entity IDs that have all required components
   * @param world The game world (for querying/modifying state)
   * @param dt Delta time in seconds (fixed timestep)
   */
  update(entities: EntityId[], world: GameWorld, dt: number): void;

  /**
   * Called when the system is removed from the World.
   * Use for cleanup.
   */
  destroy?(): void;
}

// ── Game World (forward reference for System interface) ─────────────────────

/**
 * The GameWorld interface that Systems interact with.
 * Provides read/write access to entities and components.
 */
export interface GameWorld {
  // Entity operations
  createEntity(tag?: string, owner?: string): EntityId;
  destroyEntity(id: EntityId): void;
  isAlive(id: EntityId): boolean;
  getEntityMeta(id: EntityId): EntityMeta | undefined;
  getEntitiesByTag(tag: string): EntityId[];

  // Component operations
  addComponent<T extends ComponentData>(entityId: EntityId, type: ComponentType, data: T): void;
  removeComponent(entityId: EntityId, type: ComponentType): void;
  getComponent<T extends ComponentData>(entityId: EntityId, type: ComponentType): T | undefined;
  hasComponent(entityId: EntityId, type: ComponentType): boolean;

  // Query
  query(...componentTypes: ComponentType[]): EntityId[];

  // Game state
  getCurrentTick(): number;
  getDeltaTime(): number;

  // Events
  emit(event: GameEvent): void;
  on(eventType: string, handler: GameEventHandler): () => void;
}

// ── Game Loop ───────────────────────────────────────────────────────────────

/** Game loop configuration */
export interface GameLoopConfig {
  /** Target tick rate in Hz (default: 20 for network games) */
  tickRate: number;
  /** Maximum ticks to simulate in one frame (prevents spiral of death, default: 5) */
  maxTicksPerFrame: number;
}

/** Game loop state */
export interface GameLoopState {
  /** Current simulation tick (monotonically increasing) */
  tick: number;
  /** Accumulated time not yet consumed by ticks (ms) */
  accumulator: number;
  /** Whether the loop is running */
  running: boolean;
  /** Fixed delta time per tick in seconds */
  fixedDt: number;
  /** Last frame timestamp (ms) from performance.now or Date.now */
  lastFrameTime: number;
}

// ── Events ──────────────────────────────────────────────────────────────────

/** Game event (typed message bus) */
export interface GameEvent {
  type: string;
  tick: number;
  data?: unknown;
}

export type GameEventHandler = (event: GameEvent) => void;

/** Built-in event types */
export const GameEventTypes = {
  ENTITY_CREATED: 'entity:created',
  ENTITY_DESTROYED: 'entity:destroyed',
  COMPONENT_ADDED: 'component:added',
  COMPONENT_REMOVED: 'component:removed',
  TICK_START: 'tick:start',
  TICK_END: 'tick:end',
  COLLISION: 'collision',
} as const;

// ── Snapshot (for rollback / state sync) ────────────────────────────────────

/** Serialized snapshot of the entire game world at a specific tick */
export interface WorldSnapshot {
  tick: number;
  timestamp: number;
  entities: SerializedEntity[];
}

export interface SerializedEntity {
  id: EntityId;
  meta: EntityMeta;
  components: Record<ComponentType, ComponentData>;
}

// ── Network Input (for Phase 2) ─────────────────────────────────────────────

/** A player's input for a specific tick */
export interface PlayerInput {
  /** Peer ID of the player */
  peerId: string;
  /** Tick this input applies to */
  tick: number;
  /** Input actions (serializable) */
  actions: string[];
  /** Analog axes */
  axes: Record<string, number>;
  /** Sequence number for ordering */
  seq: number;
}
