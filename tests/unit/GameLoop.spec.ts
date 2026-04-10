/**
 * Game Engine — GameLoop unit tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameLoop } from '../../src/core/game/GameLoop';
import { World } from '../../src/core/game/World';

describe('GameLoop — fixed timestep', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  afterEach(() => {
    world.destroy();
  });

  it('creates with default config', () => {
    const loop = new GameLoop(world);
    expect(loop.getFixedDt()).toBeCloseTo(1 / 20);
    expect(loop.getTick()).toBe(0);
    expect(loop.isRunning()).toBe(false);
  });

  it('creates with custom tick rate', () => {
    const loop = new GameLoop(world, { tickRate: 60 });
    expect(loop.getFixedDt()).toBeCloseTo(1 / 60);
  });

  it('manualStep advances ticks correctly', () => {
    const loop = new GameLoop(world, { tickRate: 20 });

    // 50ms = exactly 1 tick at 20Hz
    const ticks = loop.manualStep(50);
    expect(ticks).toBe(1);
    expect(loop.getTick()).toBe(1);
  });

  it('manualStep accumulates sub-tick time', () => {
    const loop = new GameLoop(world, { tickRate: 20 });

    // 30ms < 50ms tick period → no tick yet
    let ticks = loop.manualStep(30);
    expect(ticks).toBe(0);
    expect(loop.getTick()).toBe(0);

    // 30ms more → 60ms total → 1 tick (50ms consumed, 10ms leftover)
    ticks = loop.manualStep(30);
    expect(ticks).toBe(1);
    expect(loop.getTick()).toBe(1);
  });

  it('manualStep handles multiple ticks in one step', () => {
    const loop = new GameLoop(world, { tickRate: 20 });

    // 150ms = 3 ticks at 20Hz (50ms each)
    const ticks = loop.manualStep(150);
    expect(ticks).toBe(3);
    expect(loop.getTick()).toBe(3);
  });

  it('maxTicksPerFrame caps ticks in a single step', () => {
    const loop = new GameLoop(world, { tickRate: 20, maxTicksPerFrame: 3 });

    // 500ms = 10 ticks theoretically, but capped at 3
    const ticks = loop.manualStep(500);
    expect(ticks).toBe(3);
    expect(loop.getTick()).toBe(3);
  });

  it('forceTick advances by exactly 1 tick', () => {
    const loop = new GameLoop(world, { tickRate: 20 });

    loop.forceTick();
    expect(loop.getTick()).toBe(1);

    loop.forceTick();
    expect(loop.getTick()).toBe(2);
  });

  it('onTick callback fires after each tick', () => {
    const loop = new GameLoop(world, { tickRate: 20 });
    const callback = vi.fn();
    loop.onTick(callback);

    loop.manualStep(150); // 3 ticks
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, 1);
    expect(callback).toHaveBeenNthCalledWith(2, 2);
    expect(callback).toHaveBeenNthCalledWith(3, 3);
  });

  it('world.tick is called with correct dt', () => {
    const tickSpy = vi.spyOn(world, 'tick');
    const loop = new GameLoop(world, { tickRate: 20 });

    loop.manualStep(50);
    expect(tickSpy).toHaveBeenCalledWith(1 / 20);
  });

  it('systems execute during manualStep', () => {
    const updateFn = vi.fn();
    world.registerSystem({
      name: 'counter',
      requiredComponents: [],
      priority: 0,
      update: updateFn,
    });

    const loop = new GameLoop(world, { tickRate: 20 });
    loop.manualStep(100); // 2 ticks
    expect(updateFn).toHaveBeenCalledTimes(2);
  });
});

describe('GameLoop — start/stop', () => {
  it('start sets running to true', () => {
    const world = new World();
    let time = 0;
    const loop = new GameLoop(world, { tickRate: 20 }, () => time);

    // Mock requestAnimationFrame for browser env
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    loop.start();
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);

    vi.unstubAllGlobals();
    world.destroy();
  });

  it('double start is no-op', () => {
    const world = new World();
    const loop = new GameLoop(world, { tickRate: 20 }, () => 0);

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    loop.start();
    loop.start(); // should not throw or double-register

    loop.stop();
    vi.unstubAllGlobals();
    world.destroy();
  });

  it('stop without start is no-op', () => {
    const world = new World();
    const loop = new GameLoop(world, { tickRate: 20 });
    loop.stop(); // should not throw
    world.destroy();
  });

  it('getState returns a snapshot', () => {
    const world = new World();
    const loop = new GameLoop(world, { tickRate: 20 });

    loop.manualStep(50);
    const state = loop.getState();

    expect(state.tick).toBe(1);
    expect(state.fixedDt).toBeCloseTo(1 / 20);
    expect(state.running).toBe(false);

    world.destroy();
  });
});

describe('GameLoop — determinism', () => {
  it('same inputs produce same state regardless of frame timing', () => {
    // World A: 5 separate 50ms steps
    const worldA = new World();
    worldA.registerSystem({
      name: 'counter',
      requiredComponents: ['counter'],
      priority: 0,
      update(entities, w) {
        for (const eid of entities) {
          const c = w.getComponent<{ value: number }>(eid, 'counter')!;
          c.value++;
        }
      },
    });
    const eA = worldA.createEntity();
    worldA.addComponent(eA, 'counter', { value: 0 });

    const loopA = new GameLoop(worldA, { tickRate: 20 });
    for (let i = 0; i < 5; i++) loopA.manualStep(50);

    // World B: 1 big 250ms step
    const worldB = new World();
    worldB.registerSystem({
      name: 'counter',
      requiredComponents: ['counter'],
      priority: 0,
      update(entities, w) {
        for (const eid of entities) {
          const c = w.getComponent<{ value: number }>(eid, 'counter')!;
          c.value++;
        }
      },
    });
    const eB = worldB.createEntity();
    worldB.addComponent(eB, 'counter', { value: 0 });

    const loopB = new GameLoop(worldB, { tickRate: 20 });
    loopB.manualStep(250);

    // Both should have executed exactly 5 ticks
    const counterA = worldA.getComponent<{ value: number }>(eA, 'counter')!;
    const counterB = worldB.getComponent<{ value: number }>(eB, 'counter')!;

    expect(counterA.value).toBe(5);
    expect(counterB.value).toBe(5);
    expect(loopA.getTick()).toBe(5);
    expect(loopB.getTick()).toBe(5);

    worldA.destroy();
    worldB.destroy();
  });

  it('sub-tick remainder is preserved across steps', () => {
    const world = new World();
    const loop = new GameLoop(world, { tickRate: 20 });

    // 40ms (not enough for 1 tick at 50ms/tick)
    loop.manualStep(40);
    expect(loop.getTick()).toBe(0);

    // 20ms more → 60ms total → 1 tick, 10ms remainder
    loop.manualStep(20);
    expect(loop.getTick()).toBe(1);

    // 40ms more → 50ms total → 1 more tick
    loop.manualStep(40);
    expect(loop.getTick()).toBe(2);

    world.destroy();
  });
});
