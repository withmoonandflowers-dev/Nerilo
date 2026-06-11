/**
 * GameLoop — Deterministic fixed-timestep game loop
 *
 * Uses a fixed timestep accumulator pattern:
 *   - Accumulate elapsed wall-clock time
 *   - Consume in fixed-size dt steps (e.g., 50ms = 20 Hz)
 *   - Cap max ticks per frame to prevent spiral of death
 *
 * This ensures:
 *   1. Deterministic simulation (same dt every tick)
 *   2. Frame-rate independence (works on 30fps or 120fps displays)
 *   3. Network sync compatibility (all peers simulate the same ticks)
 *
 * In a browser environment, uses requestAnimationFrame.
 * Falls back to setInterval for headless/Node.js environments.
 */

import { logger } from '../../utils/logger';
import type { GameLoopConfig, GameLoopState } from './types';
import { World } from './World';

const DEFAULT_CONFIG: GameLoopConfig = {
  tickRate: 20,
  maxTicksPerFrame: 5,
};

export class GameLoop {
  private world: World;
  private config: GameLoopConfig;
  private state: GameLoopState;

  /** requestAnimationFrame handle (browser) or setInterval handle (Node) */
  private rafHandle: number | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** External tick callback (called after each world.tick) */
  private onTickCallback: ((tick: number) => void) | null = null;

  /** Time provider (overridable for testing) */
  private now: () => number;

  constructor(world: World, config?: Partial<GameLoopConfig>, nowFn?: () => number) {
    this.world = world;
    this.config = { ...DEFAULT_CONFIG, ...config };

    const fixedDt = 1 / this.config.tickRate;
    this.state = {
      tick: 0,
      accumulator: 0,
      running: false,
      fixedDt,
      lastFrameTime: 0,
    };

    // Allow injectable time source for deterministic testing
    this.now = nowFn ?? (() =>
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    );
  }

  /** Register a callback invoked after each simulation tick */
  onTick(cb: (tick: number) => void): void {
    this.onTickCallback = cb;
  }

  /** Start the game loop */
  start(): void {
    if (this.state.running) return;

    this.state.running = true;
    this.state.lastFrameTime = this.now();
    this.state.accumulator = 0;

    // Sync world tick
    this.world.setCurrentTick(this.state.tick);

    logger.info('[GameLoop] Started', {
      tickRate: this.config.tickRate,
      fixedDt: this.state.fixedDt,
    });

    if (typeof requestAnimationFrame !== 'undefined') {
      this.scheduleRaf();
    } else {
      // Node.js / headless: use setInterval at tick rate
      const intervalMs = Math.floor(1000 / this.config.tickRate);
      this.intervalHandle = setInterval(() => this.frame(), intervalMs);
    }
  }

  /** Stop the game loop */
  stop(): void {
    if (!this.state.running) return;
    this.state.running = false;

    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    logger.info('[GameLoop] Stopped', { tick: this.state.tick });
  }

  /** Get current state (read-only snapshot) */
  getState(): Readonly<GameLoopState> {
    return { ...this.state };
  }

  /** Get the fixed delta time per tick in seconds */
  getFixedDt(): number {
    return this.state.fixedDt;
  }

  /** Get current tick number */
  getTick(): number {
    return this.state.tick;
  }

  /** Is the loop currently running? */
  isRunning(): boolean {
    return this.state.running;
  }

  /**
   * Manually advance the simulation by a given elapsed time (ms).
   * Useful for testing and headless server ticking.
   */
  manualStep(elapsedMs: number): number {
    return this.advanceSimulation(elapsedMs / 1000);
  }

  /**
   * Force a single tick regardless of accumulator.
   * Useful for testing.
   */
  forceTick(): void {
    this.executeTick();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /** One frame: accumulate time, consume fixed ticks */
  private frame(): void {
    if (!this.state.running) return;

    const now = this.now();
    const elapsed = (now - this.state.lastFrameTime) / 1000; // seconds
    this.state.lastFrameTime = now;

    // Guard against huge time jumps (e.g., tab was backgrounded)
    const clampedElapsed = Math.min(elapsed, this.state.fixedDt * this.config.maxTicksPerFrame);

    this.advanceSimulation(clampedElapsed);

    // Schedule next frame
    if (this.state.running && typeof requestAnimationFrame !== 'undefined') {
      this.scheduleRaf();
    }
  }

  /**
   * Core accumulator loop: consume elapsed time in fixed-step ticks.
   * Returns the number of ticks executed.
   */
  private advanceSimulation(elapsedSeconds: number): number {
    this.state.accumulator += elapsedSeconds;

    let ticksExecuted = 0;
    // Epsilon to handle floating-point accumulation errors
    // (e.g., 0.15 - 0.05 - 0.05 = 0.04999... instead of 0.05)
    const epsilon = this.state.fixedDt * 1e-6;

    while (this.state.accumulator >= this.state.fixedDt - epsilon && ticksExecuted < this.config.maxTicksPerFrame) {
      this.executeTick();
      this.state.accumulator -= this.state.fixedDt;
      ticksExecuted++;
    }

    // Clamp negative accumulator from epsilon tolerance
    if (this.state.accumulator < 0) this.state.accumulator = 0;

    return ticksExecuted;
  }

  /** Execute a single simulation tick */
  private executeTick(): void {
    this.world.tick(this.state.fixedDt);
    this.state.tick++;

    if (this.onTickCallback) {
      try {
        this.onTickCallback(this.state.tick);
      } catch (err) {
        logger.error('[GameLoop] onTick callback error', { tick: this.state.tick, err });
      }
    }
  }

  private scheduleRaf(): void {
    this.rafHandle = requestAnimationFrame(() => this.frame());
  }
}
