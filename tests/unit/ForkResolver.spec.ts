import { describe, it, expect } from 'vitest';
import { ForkResolver } from '../../src/core/ledger/ForkResolver';
import type { LedgerEntry, LedgerFork } from '../../src/types';

function makeEntry(
  index: number,
  previousHash: string,
  entryHash: string,
  overrides: Partial<LedgerEntry> = {}
): LedgerEntry {
  return {
    index,
    previousHash,
    payloadHash: `ph-${entryHash}`,
    timestamp: 1000 + index,
    creatorId: 'creator-a',
    payload: { data: index },
    entryHash,
    ...overrides,
  };
}

describe('ForkResolver', () => {
  let resolver: ForkResolver;

  beforeEach(() => {
    resolver = new ForkResolver();
  });

  describe('detectFork', () => {
    it('returns false for normal sequential append', () => {
      const chain: LedgerEntry[] = [
        makeEntry(0, '0', 'hash-0'),
        makeEntry(1, 'hash-0', 'hash-1'),
      ];
      const newEntry = makeEntry(2, 'hash-1', 'hash-2');
      expect(resolver.detectFork(chain, newEntry)).toBe(false);
    });

    it('returns true when two entries share the same previousHash', () => {
      const chain: LedgerEntry[] = [
        makeEntry(0, '0', 'hash-0'),
        makeEntry(1, 'hash-0', 'hash-1a'),
      ];
      // New entry also has previousHash='hash-0' but different entryHash
      const newEntry = makeEntry(1, 'hash-0', 'hash-1b');
      expect(resolver.detectFork(chain, newEntry)).toBe(true);
    });

    it('returns false when chain is empty', () => {
      const newEntry = makeEntry(0, '0', 'hash-0');
      expect(resolver.detectFork([], newEntry)).toBe(false);
    });

    it('returns false when entry has unique previousHash not in chain', () => {
      const chain: LedgerEntry[] = [makeEntry(0, '0', 'hash-0')];
      const newEntry = makeEntry(1, 'hash-0', 'hash-1');
      expect(resolver.detectFork(chain, newEntry)).toBe(false);
    });
  });

  describe('resolve', () => {
    it('picks winner by timestamp ASC', () => {
      const branch1 = makeEntry(1, 'hash-0', 'hash-1a', { timestamp: 2000, creatorId: 'c-b' });
      const branch2 = makeEntry(1, 'hash-0', 'hash-1b', { timestamp: 1000, creatorId: 'c-a' });
      const fork: LedgerFork = {
        parentHash: 'hash-0',
        branches: [branch1, branch2],
        orphans: [],
      };
      const { winner, orphans } = resolver.resolve(fork);
      // branch2 has earlier timestamp
      expect(winner.entryHash).toBe('hash-1b');
      expect(orphans).toHaveLength(1);
      expect(orphans[0].entryHash).toBe('hash-1a');
    });

    it('breaks timestamp ties by creatorId ASC', () => {
      const branch1 = makeEntry(1, 'hash-0', 'hash-1a', { timestamp: 1000, creatorId: 'c-z' });
      const branch2 = makeEntry(1, 'hash-0', 'hash-1b', { timestamp: 1000, creatorId: 'c-a' });
      const fork: LedgerFork = {
        parentHash: 'hash-0',
        branches: [branch1, branch2],
        orphans: [],
      };
      const { winner } = resolver.resolve(fork);
      expect(winner.entryHash).toBe('hash-1b'); // 'c-a' < 'c-z'
    });

    it('breaks creatorId ties by entryHash ASC', () => {
      const branch1 = makeEntry(1, 'hash-0', 'zzz-hash', {
        timestamp: 1000,
        creatorId: 'same-creator',
      });
      const branch2 = makeEntry(1, 'hash-0', 'aaa-hash', {
        timestamp: 1000,
        creatorId: 'same-creator',
      });
      const fork: LedgerFork = {
        parentHash: 'hash-0',
        branches: [branch1, branch2],
        orphans: [],
      };
      const { winner } = resolver.resolve(fork);
      expect(winner.entryHash).toBe('aaa-hash'); // 'aaa' < 'zzz'
    });
  });

  describe('applyResolution', () => {
    it('removes orphans and keeps winner in chain', () => {
      const e0 = makeEntry(0, '0', 'hash-0');
      const e1a = makeEntry(1, 'hash-0', 'hash-1a', { timestamp: 2000 });
      const e1b = makeEntry(1, 'hash-0', 'hash-1b', { timestamp: 1000 }); // winner
      const chain = [e0, e1a, e1b];

      const fork: LedgerFork = {
        parentHash: 'hash-0',
        branches: [e1a, e1b],
        resolvedWinner: e1b,
        orphans: [e1a],
      };

      const resolved = resolver.applyResolution(chain, fork);
      expect(resolved.find((e) => e.entryHash === 'hash-1a')).toBeUndefined();
      expect(resolved.find((e) => e.entryHash === 'hash-1b')).toBeDefined();
    });

    it('resolves winner automatically if not pre-set', () => {
      const e0 = makeEntry(0, '0', 'hash-0');
      const e1a = makeEntry(1, 'hash-0', 'hash-1a', { timestamp: 500 });
      const e1b = makeEntry(1, 'hash-0', 'hash-1b', { timestamp: 1000 });
      const chain = [e0, e1a, e1b];

      const fork: LedgerFork = {
        parentHash: 'hash-0',
        branches: [e1a, e1b],
        orphans: [],
      };

      const resolved = resolver.applyResolution(chain, fork);
      // e1a has earlier timestamp, should win
      expect(resolved.find((e) => e.entryHash === 'hash-1a')).toBeDefined();
      expect(resolved.find((e) => e.entryHash === 'hash-1b')).toBeUndefined();
    });
  });

  describe('verifyNoForks', () => {
    it('returns valid=true for a clean sequential chain', () => {
      const chain = [
        makeEntry(0, '0', 'hash-0'),
        makeEntry(1, 'hash-0', 'hash-1'),
        makeEntry(2, 'hash-1', 'hash-2'),
      ];
      const result = resolver.verifyNoForks(chain);
      expect(result.valid).toBe(true);
      expect(result.forks).toHaveLength(0);
    });

    it('returns valid=false and lists forks for a forked chain', () => {
      const chain = [
        makeEntry(0, '0', 'hash-0'),
        makeEntry(1, 'hash-0', 'hash-1a'),
        makeEntry(1, 'hash-0', 'hash-1b'),
      ];
      const result = resolver.verifyNoForks(chain);
      expect(result.valid).toBe(false);
      expect(result.forks).toHaveLength(1);
      expect(result.forks[0].parentHash).toBe('hash-0');
      expect(result.forks[0].branches).toHaveLength(2);
    });

    it('returns valid=true for an empty chain', () => {
      const result = resolver.verifyNoForks([]);
      expect(result.valid).toBe(true);
    });
  });
});
