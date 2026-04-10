/**
 * World — Entity Component System implementation
 *
 * The World is the central data structure of the game engine.
 * It owns all entities, components, and systems, and orchestrates
 * the update loop.
 *
 * Design choices:
 *   - SoA (Structure of Arrays) component storage for cache efficiency
 *   - Archetype-free: uses Map<ComponentType, Map<EntityId, Data>> for flexibility
 *   - Systems sorted by priority once at registration time
 *   - Event bus for decoupled entity lifecycle notifications
 */

import { logger } from '../../utils/logger';
import type {
  EntityId,
  EntityMeta,
  ComponentType,
  ComponentData,
  System,
  GameWorld,
  GameEvent,
  GameEventHandler,
  WorldSnapshot,
  SerializedEntity,
} from './types';
import { GameEventTypes } from './types';

export class World implements GameWorld {
  // ── Entity Storage ──────────────────────────────────────────────────────
  private nextEntityId: EntityId = 1;
  private entities = new Map<EntityId, EntityMeta>();
  private currentTick = 0;
  private fixedDt = 1 / 20; // default 20 Hz, overridden by GameLoop

  // ── Component Storage (SoA: per-type → per-entity) ──────────────────────
  private components = new Map<ComponentType, Map<EntityId, ComponentData>>();

  // ── Systems ─────────────────────────────────────────────────────────────
  private systems: System[] = [];
  private systemsSorted = false;

  // ── Event Bus ───────────────────────────────────────────────────────────
  private eventHandlers = new Map<string, Set<GameEventHandler>>();

  // ── Bitmask Archetype (業界最佳實踐：bitECS 風格) ─────────────────────
  /** ComponentType → bit index (自動遞增分配) */
  private componentBitIndex = new Map<ComponentType, number>();
  private nextBitIndex = 0;
  /** EntityId → 該 entity 擁有的 component bitmask */
  private entityArchetype = new Map<EntityId, number>();

  // ── Delta Tracking（業界最佳實踐：delta rollback 用） ────────────────
  /** 本 tick 被修改過的 entity+component 組合 */
  private dirtyComponents = new Set<string>(); // format: "entityId:componentType"
  /** 本 tick 新增的 entity */
  private createdEntities = new Set<EntityId>();
  /** 本 tick 銷毀的 entity */
  private destroyedEntitiesSet = new Set<EntityId>();

  // ── Query Cache (invalidated on component add/remove) ───────────────────
  private queryCache = new Map<string, EntityId[]>();
  private queryCacheDirty = true;

  // ── Entity Operations ─────────────────────────────────────────────────

  createEntity(tag?: string, owner?: string): EntityId {
    const id = this.nextEntityId++;
    const meta: EntityMeta = {
      id,
      tag,
      owner,
      active: true,
      createdAt: this.currentTick,
      destroyedAt: 0,
    };
    this.entities.set(id, meta);
    this.entityArchetype.set(id, 0);
    this.createdEntities.add(id);
    this.invalidateQueryCache();

    this.emit({
      type: GameEventTypes.ENTITY_CREATED,
      tick: this.currentTick,
      data: { entityId: id, tag, owner },
    });

    return id;
  }

  destroyEntity(id: EntityId): void {
    const meta = this.entities.get(id);
    if (!meta || meta.destroyedAt > 0) return;

    meta.active = false;
    meta.destroyedAt = this.currentTick;

    // Remove all components
    for (const [type, store] of this.components) {
      if (store.delete(id)) {
        this.emit({
          type: GameEventTypes.COMPONENT_REMOVED,
          tick: this.currentTick,
          data: { entityId: id, componentType: type },
        });
      }
    }

    this.entities.delete(id);
    this.entityArchetype.delete(id);
    this.destroyedEntitiesSet.add(id);
    this.invalidateQueryCache();

    this.emit({
      type: GameEventTypes.ENTITY_DESTROYED,
      tick: this.currentTick,
      data: { entityId: id },
    });
  }

  isAlive(id: EntityId): boolean {
    const meta = this.entities.get(id);
    return !!meta && meta.active && meta.destroyedAt === 0;
  }

  getEntityMeta(id: EntityId): EntityMeta | undefined {
    return this.entities.get(id);
  }

  getEntitiesByTag(tag: string): EntityId[] {
    const result: EntityId[] = [];
    for (const [id, meta] of this.entities) {
      if (meta.active && meta.tag === tag) {
        result.push(id);
      }
    }
    return result;
  }

  getEntityCount(): number {
    return this.entities.size;
  }

  // ── Component Operations ──────────────────────────────────────────────

  addComponent<T extends ComponentData>(entityId: EntityId, type: ComponentType, data: T): void {
    if (!this.entities.has(entityId)) {
      logger.warn('[World] addComponent: entity does not exist', { entityId, type });
      return;
    }

    let store = this.components.get(type);
    if (!store) {
      store = new Map();
      this.components.set(type, store);
    }

    store.set(entityId, data);
    // 更新 bitmask archetype
    const bit = this.getOrAllocBit(type);
    const current = this.entityArchetype.get(entityId) ?? 0;
    this.entityArchetype.set(entityId, current | (1 << bit));
    // Delta tracking
    this.dirtyComponents.add(`${entityId}:${type}`);
    this.invalidateQueryCache();

    this.emit({
      type: GameEventTypes.COMPONENT_ADDED,
      tick: this.currentTick,
      data: { entityId, componentType: type },
    });
  }

  removeComponent(entityId: EntityId, type: ComponentType): void {
    const store = this.components.get(type);
    if (!store || !store.has(entityId)) return;

    store.delete(entityId);
    // 更新 bitmask archetype
    const bitIndex = this.componentBitIndex.get(type);
    if (bitIndex !== undefined) {
      const current = this.entityArchetype.get(entityId) ?? 0;
      this.entityArchetype.set(entityId, current & ~(1 << bitIndex));
    }
    this.invalidateQueryCache();

    this.emit({
      type: GameEventTypes.COMPONENT_REMOVED,
      tick: this.currentTick,
      data: { entityId, componentType: type },
    });
  }

  getComponent<T extends ComponentData>(entityId: EntityId, type: ComponentType): T | undefined {
    return this.components.get(type)?.get(entityId) as T | undefined;
  }

  hasComponent(entityId: EntityId, type: ComponentType): boolean {
    return this.components.get(type)?.has(entityId) ?? false;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /**
   * Get all entity IDs that have ALL of the specified component types.
   * Results are cached until the next add/remove invalidates the cache.
   */
  query(...componentTypes: ComponentType[]): EntityId[] {
    if (componentTypes.length === 0) {
      return [...this.entities.keys()].filter(id => this.entities.get(id)!.active);
    }

    const cacheKey = componentTypes.sort().join('|');

    if (!this.queryCacheDirty) {
      const cached = this.queryCache.get(cacheKey);
      if (cached) return cached;
    }

    // 建構查詢 bitmask（所有要求的 component 的 OR）
    let requiredMask = 0;
    for (const type of componentTypes) {
      const bit = this.componentBitIndex.get(type);
      if (bit === undefined) {
        // 這個 component type 從未被加到任何 entity → 結果必為空
        this.queryCache.set(cacheKey, []);
        return [];
      }
      requiredMask |= (1 << bit);
    }

    // Bitmask 加速查詢：只要 (archetype & requiredMask) === requiredMask 就是匹配
    // Bitmask 加速查詢：(archetype & requiredMask) === requiredMask 即匹配
    const result: EntityId[] = [];
    for (const [entityId, archetype] of this.entityArchetype) {
      if ((archetype & requiredMask) !== requiredMask) continue;
      const meta = this.entities.get(entityId);
      if (!meta || !meta.active) continue;
      result.push(entityId);
    }

    this.queryCache.set(cacheKey, result);
    return result;
  }

  // ── Systems ───────────────────────────────────────────────────────────

  registerSystem(system: System): void {
    this.systems.push(system);
    this.systemsSorted = false;
    system.init?.(this);
  }

  removeSystem(name: string): void {
    const idx = this.systems.findIndex(s => s.name === name);
    if (idx >= 0) {
      this.systems[idx].destroy?.();
      this.systems.splice(idx, 1);
    }
  }

  getSystem(name: string): System | undefined {
    return this.systems.find(s => s.name === name);
  }

  /**
   * Run one tick: execute all systems in priority order.
   */
  tick(dt: number): void {
    this.fixedDt = dt;

    // Sort systems by priority if needed
    if (!this.systemsSorted) {
      this.systems.sort((a, b) => a.priority - b.priority);
      this.systemsSorted = true;
    }

    this.emit({ type: GameEventTypes.TICK_START, tick: this.currentTick });

    // 清空上一 tick 的 delta tracking
    this.dirtyComponents.clear();
    this.createdEntities.clear();
    this.destroyedEntitiesSet.clear();

    // Clear query cache at start of tick
    this.queryCacheDirty = false;

    for (const system of this.systems) {
      const entities = this.query(...system.requiredComponents);
      system.update(entities, this, dt);
    }

    this.currentTick++;

    this.emit({ type: GameEventTypes.TICK_END, tick: this.currentTick });
  }

  // ── Game State ────────────────────────────────────────────────────────

  getCurrentTick(): number {
    return this.currentTick;
  }

  setCurrentTick(tick: number): void {
    this.currentTick = tick;
  }

  getDeltaTime(): number {
    return this.fixedDt;
  }

  // ── Events ────────────────────────────────────────────────────────────

  emit(event: GameEvent): void {
    const handlers = this.eventHandlers.get(event.type);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error('[World] Event handler error', { eventType: event.type, err });
      }
    }
  }

  on(eventType: string, handler: GameEventHandler): () => void {
    let handlers = this.eventHandlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => { handlers!.delete(handler); };
  }

  // ── Delta Tracking API ───────────────────────────────────────────────

  /** 取得本 tick 被修改過的 entity+component 組合 */
  getDirtyComponents(): ReadonlySet<string> {
    return this.dirtyComponents;
  }

  /** 取得本 tick 新增的 entity */
  getCreatedEntities(): ReadonlySet<EntityId> {
    return this.createdEntities;
  }

  /** 取得本 tick 銷毀的 entity */
  getDestroyedEntities(): ReadonlySet<EntityId> {
    return this.destroyedEntitiesSet;
  }

  /**
   * 產生 delta snapshot：只包含本 tick 被修改過的 component。
   * 比完整快照輕量得多（業界建議的 delta rollback 做法）。
   */
  takeDeltaSnapshot(): { tick: number; changes: Map<EntityId, Record<ComponentType, ComponentData>>; created: EntityId[]; destroyed: EntityId[] } {
    const changes = new Map<EntityId, Record<ComponentType, ComponentData>>();

    for (const key of this.dirtyComponents) {
      const [eidStr, type] = key.split(':');
      const eid = Number(eidStr);
      const data = this.getComponent(eid, type);
      if (data) {
        let entry = changes.get(eid);
        if (!entry) {
          entry = {};
          changes.set(eid, entry);
        }
        entry[type] = JSON.parse(JSON.stringify(data));
      }
    }

    return {
      tick: this.currentTick,
      changes,
      created: [...this.createdEntities],
      destroyed: [...this.destroyedEntitiesSet],
    };
  }

  // ── Snapshot (Serialization) ──────────────────────────────────────────

  /**
   * Capture a complete snapshot of the world state.
   * Used for rollback, state sync, and save/load.
   */
  takeSnapshot(): WorldSnapshot {
    const entities: SerializedEntity[] = [];

    for (const [id, meta] of this.entities) {
      if (!meta.active) continue;

      const components: Record<ComponentType, ComponentData> = {};
      for (const [type, store] of this.components) {
        const data = store.get(id);
        if (data) {
          // Deep clone to avoid mutation
          components[type] = JSON.parse(JSON.stringify(data));
        }
      }

      entities.push({
        id,
        meta: { ...meta },
        components,
      });
    }

    return {
      tick: this.currentTick,
      timestamp: Date.now(),
      entities,
    };
  }

  /**
   * Restore world state from a snapshot.
   * Clears all current state and rebuilds from the snapshot.
   */
  restoreSnapshot(snapshot: WorldSnapshot): void {
    // Clear current state
    this.entities.clear();
    this.components.clear();
    this.entityArchetype.clear();
    this.invalidateQueryCache();

    this.currentTick = snapshot.tick;

    let maxId = 0;
    for (const serialized of snapshot.entities) {
      this.entities.set(serialized.id, { ...serialized.meta });
      if (serialized.id >= maxId) maxId = serialized.id;

      let archetype = 0;
      for (const [type, data] of Object.entries(serialized.components)) {
        let store = this.components.get(type);
        if (!store) {
          store = new Map();
          this.components.set(type, store);
        }
        store.set(serialized.id, JSON.parse(JSON.stringify(data)));
        archetype |= (1 << this.getOrAllocBit(type));
      }
      this.entityArchetype.set(serialized.id, archetype);
    }

    this.nextEntityId = maxId + 1;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy(): void {
    for (const system of this.systems) {
      system.destroy?.();
    }
    this.systems = [];
    this.entities.clear();
    this.components.clear();
    this.eventHandlers.clear();
    this.queryCache.clear();
    this.entityArchetype.clear();
    this.componentBitIndex.clear();
    this.nextBitIndex = 0;
    this.dirtyComponents.clear();
    this.createdEntities.clear();
    this.destroyedEntitiesSet.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /** 取得或分配 component type 的 bit 位置（最多支援 31 種 component type） */
  private getOrAllocBit(type: ComponentType): number {
    let bit = this.componentBitIndex.get(type);
    if (bit === undefined) {
      bit = this.nextBitIndex++;
      this.componentBitIndex.set(type, bit);
    }
    return bit;
  }

  private invalidateQueryCache(): void {
    this.queryCacheDirty = true;
    this.queryCache.clear();
  }
}
