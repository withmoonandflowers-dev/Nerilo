/**
 * Deterministic RNG (xorshift128+)
 *
 * Produces identical sequences on all peers given the same seed.
 * Essential for lockstep game simulation — all peers must agree on
 * random outcomes without communicating each result.
 *
 * Seed negotiation uses hash-then-reveal protocol in GameSession
 * to prevent any peer from biasing the seed.
 */

import type { RNGState } from './types';

export class DeterministicRNG {
  private s0: number;
  private s1: number;
  private _callCount = 0;
  private readonly _seed: number;

  constructor(seed: number) {
    this._seed = seed;
    // Initialize state from seed using splitmix64-like seeding
    this.s0 = seed | 0;
    this.s1 = (seed * 1103515245 + 12345) | 0;
    // Warm up: discard first 20 values to improve initial distribution
    for (let i = 0; i < 20; i++) this._next();
    this._callCount = 0; // Reset counter after warmup
  }

  /** Core: xorshift128+ step, returns 32-bit integer */
  private _next(): number {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.s1 = s1;
    return (this.s0 + this.s1) | 0;
  }

  /** Returns float in [0, 1) */
  next(): number {
    this._callCount++;
    return (this._next() >>> 0) / 0x100000000;
  }

  /** Returns integer in [min, max] (inclusive) */
  nextInt(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Returns float in [min, max) */
  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Returns boolean with given probability (default 0.5) */
  nextBool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Fisher-Yates shuffle using this RNG (deterministic) */
  shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /** Get current state for snapshot persistence */
  getState(): RNGState {
    return { seed: this._seed, callCount: this._callCount };
  }

  /** Get the original seed */
  get seed(): number {
    return this._seed;
  }

  /** Get how many times next() has been called */
  get callCount(): number {
    return this._callCount;
  }

  /** Reconstruct RNG at a specific point in the sequence */
  static fromState(state: RNGState): DeterministicRNG {
    const rng = new DeterministicRNG(state.seed);
    rng.fastForward(state.callCount);
    return rng;
  }

  /** Advance to a specific callCount (for late joiners) */
  fastForward(targetCallCount: number): void {
    while (this._callCount < targetCallCount) {
      this.next();
    }
  }
}
