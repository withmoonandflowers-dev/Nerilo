/**
 * Game Engine — World (ECS) unit tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { World } from '../../src/core/game/World';
import { GameEventTypes } from '../../src/core/game/types';
import type { System } from '../../src/core/game/types';

describe('World — Entity management', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('creates entities with incrementing IDs', () => {
    const e1 = world.createEntity('player');
    const e2 = world.createEntity('enemy');
    expect(e2).toBe(e1 + 1);
    expect(world.isAlive(e1)).toBe(true);
    expect(world.isAlive(e2)).toBe(true);
  });

  it('creates entities with tag and owner', () => {
    const id = world.createEntity('bullet', 'peer-1');
    const meta = world.getEntityMeta(id);
    expect(meta?.tag).toBe('bullet');
    expect(meta?.owner).toBe('peer-1');
    expect(meta?.active).toBe(true);
    expect(meta?.destroyedAt).toBe(0);
  });

  it('destroys entities', () => {
    const id = world.createEntity('temp');
    world.destroyEntity(id);
    expect(world.isAlive(id)).toBe(false);
    expect(world.getEntityMeta(id)).toBeUndefined();
  });

  it('destroying removes all components', () => {
    const id = world.createEntity();
    world.addComponent(id, 'position', { x: 10, y: 20 });
    world.addComponent(id, 'health', { current: 100, max: 100 });

    world.destroyEntity(id);
    expect(world.getComponent(id, 'position')).toBeUndefined();
    expect(world.getComponent(id, 'health')).toBeUndefined();
  });

  it('getEntitiesByTag returns matching entities', () => {
    world.createEntity('player');
    world.createEntity('enemy');
    world.createEntity('player');
    world.createEntity('obstacle');

    const players = world.getEntitiesByTag('player');
    expect(players).toHaveLength(2);

    const enemies = world.getEntitiesByTag('enemy');
    expect(enemies).toHaveLength(1);
  });

  it('destroyed entities do not appear in getEntitiesByTag', () => {
    const id = world.createEntity('player');
    world.createEntity('player');
    world.destroyEntity(id);

    expect(world.getEntitiesByTag('player')).toHaveLength(1);
  });

  it('double destroy is no-op', () => {
    const id = world.createEntity();
    world.destroyEntity(id);
    world.destroyEntity(id); // should not throw
  });

  it('isAlive returns false for non-existent entity', () => {
    expect(world.isAlive(9999)).toBe(false);
  });

  it('getEntityCount tracks live entities', () => {
    world.createEntity();
    world.createEntity();
    const e3 = world.createEntity();
    expect(world.getEntityCount()).toBe(3);

    world.destroyEntity(e3);
    expect(world.getEntityCount()).toBe(2);
  });
});

describe('World — Component management', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('adds and retrieves components', () => {
    const id = world.createEntity();
    world.addComponent(id, 'position', { x: 5, y: 10 });

    const pos = world.getComponent<{ x: number; y: number }>(id, 'position');
    expect(pos).toEqual({ x: 5, y: 10 });
  });

  it('hasComponent returns correct boolean', () => {
    const id = world.createEntity();
    expect(world.hasComponent(id, 'position')).toBe(false);

    world.addComponent(id, 'position', { x: 0, y: 0 });
    expect(world.hasComponent(id, 'position')).toBe(true);
  });

  it('removes components', () => {
    const id = world.createEntity();
    world.addComponent(id, 'health', { current: 50, max: 100 });
    world.removeComponent(id, 'health');

    expect(world.hasComponent(id, 'health')).toBe(false);
    expect(world.getComponent(id, 'health')).toBeUndefined();
  });

  it('overwrites component data on re-add', () => {
    const id = world.createEntity();
    world.addComponent(id, 'position', { x: 0, y: 0 });
    world.addComponent(id, 'position', { x: 99, y: 88 });

    expect(world.getComponent<{ x: number }>(id, 'position')?.x).toBe(99);
  });

  it('addComponent on non-existent entity is ignored', () => {
    // Should not throw
    world.addComponent(9999, 'position', { x: 0, y: 0 });
    expect(world.getComponent(9999, 'position')).toBeUndefined();
  });

  it('removeComponent on missing component is no-op', () => {
    const id = world.createEntity();
    // Should not throw
    world.removeComponent(id, 'nonexistent');
  });
});

describe('World — Query', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('queries entities with single component', () => {
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.createEntity(); // no component

    world.addComponent(e1, 'position', { x: 0, y: 0 });
    world.addComponent(e2, 'position', { x: 1, y: 1 });

    const result = world.query('position');
    expect(result).toHaveLength(2);
    expect(result).toContain(e1);
    expect(result).toContain(e2);
  });

  it('queries entities with multiple components (intersection)', () => {
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    const e3 = world.createEntity();

    world.addComponent(e1, 'position', { x: 0, y: 0 });
    world.addComponent(e1, 'velocity', { vx: 1, vy: 0 });

    world.addComponent(e2, 'position', { x: 0, y: 0 });
    // e2 has no velocity

    world.addComponent(e3, 'velocity', { vx: 0, vy: 1 });
    // e3 has no position

    const result = world.query('position', 'velocity');
    expect(result).toEqual([e1]);
  });

  it('returns empty for query with non-existent component type', () => {
    world.createEntity();
    expect(world.query('nonexistent')).toEqual([]);
  });

  it('returns all active entities when query has no arguments', () => {
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    const e3 = world.createEntity();
    world.destroyEntity(e2);

    const result = world.query();
    expect(result).toContain(e1);
    expect(result).toContain(e3);
    expect(result).not.toContain(e2);
  });

  it('query reflects destroyed entities', () => {
    const e1 = world.createEntity();
    world.addComponent(e1, 'position', { x: 0, y: 0 });

    expect(world.query('position')).toHaveLength(1);

    world.destroyEntity(e1);
    expect(world.query('position')).toHaveLength(0);
  });
});

describe('World — Systems', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('registers and runs a system', () => {
    const updateFn = vi.fn();
    const system: System = {
      name: 'movement',
      requiredComponents: ['position', 'velocity'],
      priority: 0,
      update: updateFn,
    };

    world.registerSystem(system);

    const e = world.createEntity();
    world.addComponent(e, 'position', { x: 0, y: 0 });
    world.addComponent(e, 'velocity', { vx: 1, vy: 2 });

    world.tick(1 / 20);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledWith([e], world, 1 / 20);
  });

  it('systems run in priority order', () => {
    const order: string[] = [];

    world.registerSystem({
      name: 'render',
      requiredComponents: [],
      priority: 100,
      update: () => order.push('render'),
    });

    world.registerSystem({
      name: 'input',
      requiredComponents: [],
      priority: -10,
      update: () => order.push('input'),
    });

    world.registerSystem({
      name: 'physics',
      requiredComponents: [],
      priority: 0,
      update: () => order.push('physics'),
    });

    world.tick(1 / 20);

    expect(order).toEqual(['input', 'physics', 'render']);
  });

  it('system init is called on registration', () => {
    const initFn = vi.fn();
    world.registerSystem({
      name: 'test',
      requiredComponents: [],
      priority: 0,
      init: initFn,
      update: () => {},
    });

    expect(initFn).toHaveBeenCalledWith(world);
  });

  it('system destroy is called on removal', () => {
    const destroyFn = vi.fn();
    world.registerSystem({
      name: 'test',
      requiredComponents: [],
      priority: 0,
      update: () => {},
      destroy: destroyFn,
    });

    world.removeSystem('test');
    expect(destroyFn).toHaveBeenCalled();
  });

  it('system only receives matching entities', () => {
    const updateFn = vi.fn();
    world.registerSystem({
      name: 'health-system',
      requiredComponents: ['health'],
      priority: 0,
      update: updateFn,
    });

    const e1 = world.createEntity();
    world.addComponent(e1, 'health', { current: 100, max: 100 });

    const _e2 = world.createEntity(); // no health component

    world.tick(1 / 20);

    expect(updateFn).toHaveBeenCalledWith([e1], world, expect.any(Number));
  });

  it('a real movement system modifies components', () => {
    // Movement system: position += velocity * dt
    world.registerSystem({
      name: 'movement',
      requiredComponents: ['position', 'velocity'],
      priority: 0,
      update(entities, w, dt) {
        for (const eid of entities) {
          const pos = w.getComponent<{ x: number; y: number }>(eid, 'position')!;
          const vel = w.getComponent<{ vx: number; vy: number }>(eid, 'velocity')!;
          pos.x += vel.vx * dt;
          pos.y += vel.vy * dt;
        }
      },
    });

    const e = world.createEntity();
    world.addComponent(e, 'position', { x: 0, y: 0 });
    world.addComponent(e, 'velocity', { vx: 100, vy: 50 });

    // 10 ticks at 20Hz (0.5 seconds)
    for (let i = 0; i < 10; i++) {
      world.tick(1 / 20);
    }

    const pos = world.getComponent<{ x: number; y: number }>(e, 'position')!;
    expect(pos.x).toBeCloseTo(50, 1); // 100 * 0.5
    expect(pos.y).toBeCloseTo(25, 1); // 50 * 0.5
  });

  it('getSystem returns registered system', () => {
    world.registerSystem({
      name: 'test',
      requiredComponents: [],
      priority: 0,
      update: () => {},
    });

    expect(world.getSystem('test')?.name).toBe('test');
    expect(world.getSystem('nonexistent')).toBeUndefined();
  });
});

describe('World — Events', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('emits ENTITY_CREATED event', () => {
    const handler = vi.fn();
    world.on(GameEventTypes.ENTITY_CREATED, handler);

    const id = world.createEntity('player', 'peer-1');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: GameEventTypes.ENTITY_CREATED,
      data: { entityId: id, tag: 'player', owner: 'peer-1' },
    }));
  });

  it('emits ENTITY_DESTROYED event', () => {
    const handler = vi.fn();
    world.on(GameEventTypes.ENTITY_DESTROYED, handler);

    const id = world.createEntity();
    world.destroyEntity(id);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: GameEventTypes.ENTITY_DESTROYED,
      data: { entityId: id },
    }));
  });

  it('emits COMPONENT_ADDED and COMPONENT_REMOVED events', () => {
    const addHandler = vi.fn();
    const removeHandler = vi.fn();
    world.on(GameEventTypes.COMPONENT_ADDED, addHandler);
    world.on(GameEventTypes.COMPONENT_REMOVED, removeHandler);

    const id = world.createEntity();
    world.addComponent(id, 'position', { x: 0, y: 0 });
    world.removeComponent(id, 'position');

    expect(addHandler).toHaveBeenCalledWith(expect.objectContaining({
      data: { entityId: id, componentType: 'position' },
    }));
    expect(removeHandler).toHaveBeenCalledWith(expect.objectContaining({
      data: { entityId: id, componentType: 'position' },
    }));
  });

  it('emits TICK_START and TICK_END events', () => {
    const startHandler = vi.fn();
    const endHandler = vi.fn();
    world.on(GameEventTypes.TICK_START, startHandler);
    world.on(GameEventTypes.TICK_END, endHandler);

    world.tick(1 / 20);

    expect(startHandler).toHaveBeenCalledTimes(1);
    expect(endHandler).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from events', () => {
    const handler = vi.fn();
    const unsub = world.on(GameEventTypes.ENTITY_CREATED, handler);

    world.createEntity();
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    world.createEntity();
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });
});

describe('World — Snapshot', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  it('takes and restores a snapshot', () => {
    const e1 = world.createEntity('player');
    world.addComponent(e1, 'position', { x: 10, y: 20 });
    world.addComponent(e1, 'health', { current: 80, max: 100 });

    const e2 = world.createEntity('enemy');
    world.addComponent(e2, 'position', { x: 50, y: 60 });

    // Advance some ticks
    world.tick(1 / 20);
    world.tick(1 / 20);

    const snapshot = world.takeSnapshot();
    expect(snapshot.entities).toHaveLength(2);
    expect(snapshot.tick).toBe(2);

    // Destroy everything
    world.destroy();
    expect(world.getEntityCount()).toBe(0);

    // Restore
    world.restoreSnapshot(snapshot);
    expect(world.getEntityCount()).toBe(2);
    expect(world.getCurrentTick()).toBe(2);

    const pos = world.getComponent<{ x: number; y: number }>(e1, 'position');
    expect(pos).toEqual({ x: 10, y: 20 });
  });

  it('snapshot is a deep copy (mutations do not affect original)', () => {
    const e = world.createEntity();
    world.addComponent(e, 'position', { x: 0, y: 0 });

    const snapshot = world.takeSnapshot();

    // Mutate original
    const pos = world.getComponent<{ x: number; y: number }>(e, 'position')!;
    pos.x = 999;

    // Snapshot should be unaffected
    expect(snapshot.entities[0].components['position']).toEqual({ x: 0, y: 0 });
  });

  it('restored snapshot allows creating new entities with correct IDs', () => {
    const e1 = world.createEntity();
    world.addComponent(e1, 'test', { v: 1 });

    const snapshot = world.takeSnapshot();
    world.destroy();
    world.restoreSnapshot(snapshot);

    // New entity should have ID > e1
    const e2 = world.createEntity();
    expect(e2).toBeGreaterThan(e1);
  });
});

describe('World — destroy', () => {
  it('cleans up all state', () => {
    const world = new World();
    const destroyFn = vi.fn();

    world.registerSystem({
      name: 'sys',
      requiredComponents: [],
      priority: 0,
      update: () => {},
      destroy: destroyFn,
    });

    world.createEntity();
    world.createEntity();

    world.destroy();

    expect(destroyFn).toHaveBeenCalled();
    expect(world.getEntityCount()).toBe(0);
    expect(world.query()).toEqual([]);
  });
});
