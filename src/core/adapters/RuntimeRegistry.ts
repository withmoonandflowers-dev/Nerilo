/**
 * RuntimeRegistry — Global singleton for the active runtime
 *
 * Provides a central access point for the current adapter implementations.
 * Initialize once at app startup; all core modules access adapters via this.
 *
 * Usage:
 *   // At startup (browser):
 *   import { BrowserRuntime } from './BrowserRuntime';
 *   RuntimeRegistry.init(new BrowserRuntime(localId));
 *
 *   // At startup (node):
 *   import { NodeRuntime } from './NodeRuntime';
 *   RuntimeRegistry.init(new NodeRuntime('node', localId));
 *
 *   // In core modules:
 *   const runtime = RuntimeRegistry.get();
 *   const data = await runtime.storage.get('store', 'key');
 */

import type { IRuntime, RuntimeType } from './types';

let currentRuntime: IRuntime | null = null;

export const RuntimeRegistry = {
  /**
   * Initialize the runtime. Call once at app startup.
   * Throws if already initialized (call reset() first if needed).
   */
  init(runtime: IRuntime): void {
    if (currentRuntime) {
      throw new Error(
        `Runtime already initialized as "${currentRuntime.type}". Call reset() first.`
      );
    }
    currentRuntime = runtime;
  },

  /**
   * Get the current runtime. Throws if not initialized.
   */
  get(): IRuntime {
    if (!currentRuntime) {
      throw new Error('Runtime not initialized. Call RuntimeRegistry.init() first.');
    }
    return currentRuntime;
  },

  /**
   * Check the current runtime type.
   */
  getType(): RuntimeType | null {
    return currentRuntime?.type ?? null;
  },

  /**
   * Check if a runtime has been initialized.
   */
  isInitialized(): boolean {
    return currentRuntime !== null;
  },

  /**
   * Reset the runtime (for testing or hot-swap).
   */
  reset(): void {
    currentRuntime = null;
  },
};
