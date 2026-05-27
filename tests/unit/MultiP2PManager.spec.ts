/**
 * MultiP2PManager unit tests
 *
 * NOTE: MultiP2PManager has been deprecated and replaced by
 *  useStarTopology / useMeshTopology hooks. The module is now an empty
 *  re-export. These tests pin that fact so that any future re-introduction
 *  of multi-peer connection management is preceded by deliberate test work
 *  (i.e., this file is the cue to write proper add/remove/broadcast tests).
 */

import { describe, it, expect } from 'vitest';

describe('MultiP2PManager (deprecated)', () => {
  it('module loads without throwing', async () => {
    await expect(import('../../src/core/p2p/MultiP2PManager')).resolves.toBeDefined();
  });

  it('exports nothing — functionality moved to topology hooks', async () => {
    const mod = await import('../../src/core/p2p/MultiP2PManager');
    // The module exists as `export {};` — should have no named exports.
    const ownKeys = Object.keys(mod).filter((k) => k !== 'default');
    expect(ownKeys).toEqual([]);
  });
});
