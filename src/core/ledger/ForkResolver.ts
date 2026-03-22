import type { LedgerEntry, LedgerFork } from '../../types';

export class ForkResolver {
  /**
   * Detect if a new entry creates a fork.
   * A fork occurs when the chain already has an entry with the same previousHash
   * but a different entryHash.
   */
  detectFork(chain: LedgerEntry[], newEntry: LedgerEntry): boolean {
    return chain.some(
      (e) =>
        e.previousHash === newEntry.previousHash &&
        e.entryHash !== newEntry.entryHash
    );
  }

  /**
   * Resolve a fork by picking a canonical winner.
   * Priority: timestamp ASC → creatorId ASC → entryHash ASC
   */
  resolve(fork: LedgerFork): { winner: LedgerEntry; orphans: LedgerEntry[] } {
    const candidates = [...fork.branches];

    candidates.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      if (a.creatorId !== b.creatorId) return a.creatorId < b.creatorId ? -1 : 1;
      return a.entryHash < b.entryHash ? -1 : 1;
    });

    const winner = candidates[0]!;
    const orphans = candidates.slice(1);

    return { winner, orphans };
  }

  /**
   * Apply resolution: remove orphans from chain, ensure winner is present.
   */
  applyResolution(chain: LedgerEntry[], fork: LedgerFork): LedgerEntry[] {
    if (!fork.resolvedWinner) {
      const { winner, orphans } = this.resolve(fork);
      fork.resolvedWinner = winner;
      fork.orphans = orphans;
    }

    const orphanHashes = new Set(fork.orphans.map((o) => o.entryHash));
    const filtered = chain.filter((e) => !orphanHashes.has(e.entryHash));

    // Ensure winner is in chain
    const winnerPresent = filtered.some((e) => e.entryHash === fork.resolvedWinner!.entryHash);
    if (!winnerPresent) {
      filtered.push(fork.resolvedWinner!);
      filtered.sort((a, b) => a.index - b.index);
    }

    return filtered;
  }

  /**
   * Verify entire chain has no forks.
   */
  verifyNoForks(chain: LedgerEntry[]): { valid: boolean; forks: LedgerFork[] } {
    const forks: LedgerFork[] = [];

    // Group by previousHash
    const byPrevHash = new Map<string, LedgerEntry[]>();
    for (const entry of chain) {
      const group = byPrevHash.get(entry.previousHash);
      if (group) {
        group.push(entry);
      } else {
        byPrevHash.set(entry.previousHash, [entry]);
      }
    }

    for (const [parentHash, entries] of byPrevHash.entries()) {
      if (entries.length > 1) {
        forks.push({
          parentHash,
          branches: entries,
          orphans: [],
        });
      }
    }

    return { valid: forks.length === 0, forks };
  }
}
