import type { LedgerEntry, LedgerFork, LedgerSnapshot } from '../../types';
import { ForkResolver } from './ForkResolver';

const SNAPSHOT_INTERVAL = 1000;

export class SharedLedgerEngine {
  private chain: LedgerEntry[] = [];
  private forkResolver = new ForkResolver();
  private entryCallbacks: Array<(entry: LedgerEntry) => void> = [];
  private forkCallbacks: Array<(fork: LedgerFork) => void> = [];
  private snapshots: LedgerSnapshot[] = [];

  // ── Core chain operations ────────────────────────────────────────────────

  getTip(): LedgerEntry | null {
    return this.chain.length > 0 ? this.chain[this.chain.length - 1]! : null;
  }

  getHeight(): number {
    return this.chain.length;
  }

  getEntry(index: number): LedgerEntry | undefined {
    return this.chain[index];
  }

  getRange(from: number, to: number): LedgerEntry[] {
    return this.chain.slice(from, to + 1);
  }

  getAll(): LedgerEntry[] {
    return [...this.chain];
  }

  // ── Append with fork detection ───────────────────────────────────────────

  async append(entry: LedgerEntry): Promise<'ok' | 'fork_detected' | 'duplicate' | 'invalid'> {
    // Check duplicate
    if (this.chain.some((e) => e.entryHash === entry.entryHash)) {
      return 'duplicate';
    }

    // Validate previousHash linkage
    const tip = this.getTip();
    const expectedPrevHash = tip ? tip.entryHash : '0';

    // For the very first entry the previousHash must be '0' (or whatever genesis hash)
    if (this.chain.length === 0) {
      // No validation on genesis - just accept
    } else {
      // Check if entry links to the current tip
      if (entry.previousHash !== expectedPrevHash) {
        // Could be a fork candidate or truly invalid
        // If previousHash matches any existing entry, it's a fork
        const parentExists = this.chain.some((e) => e.entryHash === entry.previousHash);
        if (!parentExists) {
          return 'invalid';
        }
        // It is a fork
        const forkEntry: LedgerFork = {
          parentHash: entry.previousHash,
          branches: [
            this.chain.find((e) => e.previousHash === entry.previousHash)!,
            entry,
          ],
          orphans: [],
        };
        for (const cb of this.forkCallbacks) {
          cb(forkEntry);
        }
        return 'fork_detected';
      }
    }

    // Check for fork: another entry with same previousHash already in chain
    if (this.forkResolver.detectFork(this.chain, entry)) {
      const existingBranch = this.chain.find((e) => e.previousHash === entry.previousHash)!;
      const fork: LedgerFork = {
        parentHash: entry.previousHash,
        branches: [existingBranch, entry],
        orphans: [],
      };
      for (const cb of this.forkCallbacks) {
        cb(fork);
      }
      return 'fork_detected';
    }

    this.chain.push(entry);

    // Notify callbacks
    for (const cb of this.entryCallbacks) {
      cb(entry);
    }

    // Auto snapshot
    if (this.chain.length % SNAPSHOT_INTERVAL === 0) {
      await this.createSnapshot();
    }

    return 'ok';
  }

  // ── Merge from remote ───────────────────────────────────────────────────

  async mergeEntries(
    entries: LedgerEntry[]
  ): Promise<{ added: number; forks: number; duplicates: number }> {
    let added = 0;
    let forks = 0;
    let duplicates = 0;

    // Sort by index before merging
    const sorted = [...entries].sort((a, b) => a.index - b.index);

    for (const entry of sorted) {
      const result = await this.append(entry);
      if (result === 'ok') added++;
      else if (result === 'fork_detected') forks++;
      else if (result === 'duplicate') duplicates++;
    }

    return { added, forks, duplicates };
  }

  // ── Chain integrity ─────────────────────────────────────────────────────

  verifyChain(): boolean {
    if (this.chain.length === 0) return true;

    for (let i = 1; i < this.chain.length; i++) {
      const prev = this.chain[i - 1]!;
      const curr = this.chain[i]!;

      if (curr.previousHash !== prev.entryHash) {
        return false;
      }
    }

    const { valid } = this.forkResolver.verifyNoForks(this.chain);
    return valid;
  }

  // ── Snapshot support ────────────────────────────────────────────────────

  async createSnapshot(): Promise<LedgerSnapshot> {
    const tip = this.getTip();
    const tipHash = tip ? tip.entryHash : '0';
    const upToIndex = this.chain.length - 1;

    // Serialize chain in chunks (each chunk = 100 entries, base64 encoded)
    const chunkSize = 100;
    const chunks: string[] = [];
    for (let i = 0; i <= upToIndex; i += chunkSize) {
      const chunk = this.chain.slice(i, i + chunkSize);
      chunks.push(btoa(JSON.stringify(chunk)));
    }

    const stateHash = await this.hashString(JSON.stringify(this.chain));

    const snapshot: LedgerSnapshot = {
      snapshotId: `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      roomId: tip?.roomId ?? '',
      upToIndex,
      tipHash,
      stateHash,
      createdAt: Date.now(),
      creatorId: tip?.creatorId ?? '',
      chunks,
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  async restoreFromSnapshot(
    snapshot: LedgerSnapshot,
    entries: LedgerEntry[]
  ): Promise<boolean> {
    try {
      // Restore chain from snapshot chunks if entries not provided
      let restoredEntries = entries;
      if (restoredEntries.length === 0 && snapshot.chunks.length > 0) {
        restoredEntries = snapshot.chunks.flatMap((chunk) =>
          JSON.parse(atob(chunk)) as LedgerEntry[]
        );
      }

      this.chain = restoredEntries.slice(0, snapshot.upToIndex + 1);
      this.chain.sort((a, b) => a.index - b.index);
      return true;
    } catch {
      return false;
    }
  }

  // ── Anti-entropy helpers ────────────────────────────────────────────────

  getMissingIndices(knownIndices: number[]): number[] {
    const known = new Set(knownIndices);
    return this.chain
      .map((e) => e.index)
      .filter((idx) => !known.has(idx));
  }

  getTipHash(): string {
    return this.getTip()?.entryHash ?? '0';
  }

  // ── Event subscriptions ─────────────────────────────────────────────────

  onEntry(cb: (entry: LedgerEntry) => void): () => void {
    this.entryCallbacks.push(cb);
    return () => {
      this.entryCallbacks = this.entryCallbacks.filter((h) => h !== cb);
    };
  }

  onFork(cb: (fork: LedgerFork) => void): () => void {
    this.forkCallbacks.push(cb);
    return () => {
      this.forkCallbacks = this.forkCallbacks.filter((h) => h !== cb);
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async hashString(input: string): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(input);
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback: simple deterministic hash for test environments
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }
}
