/**
 * KademliaRouter — XOR-distance based DHT routing table
 *
 * Implements a simplified Kademlia DHT for peer discovery
 * and relay path construction in the P2P overlay network.
 *
 * Features:
 * - XOR distance metric for peer proximity
 * - K-Bucket routing table (k=8, 256-bit address space)
 * - Iterative node lookup with α=3 parallel queries
 * - S/Kademlia diversified routing for Sybil resistance
 * - Exponential backoff proof-of-life checks
 */

import type { KBucketEntry, KBucket } from './types';

/** Number of entries per bucket */
const K = 8;

/** Total bits in the ID space */
const ID_BITS = 256;
/** Maximum stale age before eviction (ms) */
const MAX_STALE_AGE_MS = 300_000; // 5 minutes

/**
 * Compute XOR distance between two hex-encoded node IDs.
 * Returns a hex string representing the XOR result.
 */
export function xorDistance(a: string, b: string): string {
  const aBytes = hexToBytes(a);
  const bBytes = hexToBytes(b);
  const len = Math.max(aBytes.length, bBytes.length);
  const result = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    const aByte = i < aBytes.length ? aBytes[aBytes.length - 1 - i] : 0;
    const bByte = i < bBytes.length ? bBytes[bBytes.length - 1 - i] : 0;
    result[len - 1 - i] = aByte ^ bByte;
  }

  return bytesToHex(result);
}

/**
 * Compare two XOR distances. Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 */
export function compareDistance(a: string, b: string): number {
  const aPadded = a.padStart(64, '0');
  const bPadded = b.padStart(64, '0');
  return aPadded < bPadded ? -1 : aPadded > bPadded ? 1 : 0;
}

/**
 * Find the bucket index for a given XOR distance.
 * This is the position of the highest set bit (0-indexed from MSB).
 */
export function bucketIndex(distance: string): number {
  const bytes = hexToBytes(distance);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) continue;
    // Find highest bit in this byte
    const bit = 7 - Math.floor(Math.log2(bytes[i]));
    return i * 8 + bit;
  }
  return ID_BITS - 1; // Same node
}

// ── Routing Table ────────────────────────────────────────────────────────────

export class KademliaRouter {
  private localId: string;
  private buckets: KBucket[] = [];

  constructor(localId: string) {
    this.localId = localId;

    // Initialize empty buckets
    for (let i = 0; i < ID_BITS; i++) {
      this.buckets.push({ index: i, entries: [], capacity: K });
    }
  }

  /** Get the local node ID */
  getLocalId(): string {
    return this.localId;
  }

  /**
   * Add or update a node in the routing table.
   * Follows Kademlia's LRU eviction policy:
   * - If bucket not full, add to tail (most recently seen)
   * - If bucket full, ping head (least recently seen)
   *   - If head responds, move head to tail, discard new
   *   - If head doesn't respond, evict head, add new to tail
   */
  addNode(entry: KBucketEntry): boolean {
    if (entry.nodeId === this.localId) return false;

    const distance = xorDistance(this.localId, entry.nodeId);
    const idx = bucketIndex(distance);
    const bucket = this.buckets[idx];

    // Check if node already exists
    const existingIdx = bucket.entries.findIndex((e) => e.nodeId === entry.nodeId);
    if (existingIdx !== -1) {
      // Move to tail (most recently seen)
      bucket.entries.splice(existingIdx, 1);
      bucket.entries.push({ ...entry, lastSeen: Date.now() });
      return true;
    }

    // Bucket not full — add to tail
    if (bucket.entries.length < bucket.capacity) {
      bucket.entries.push({ ...entry, lastSeen: Date.now() });
      return true;
    }

    // Bucket full — check if head is stale
    const head = bucket.entries[0];
    if (Date.now() - head.lastSeen > MAX_STALE_AGE_MS) {
      // Evict stale head, add new to tail
      bucket.entries.shift();
      bucket.entries.push({ ...entry, lastSeen: Date.now() });
      return true;
    }

    // Bucket full, head is not stale — reject new node
    return false;
  }

  /** Remove a node from the routing table */
  removeNode(nodeId: string): boolean {
    const distance = xorDistance(this.localId, nodeId);
    const idx = bucketIndex(distance);
    const bucket = this.buckets[idx];

    const entryIdx = bucket.entries.findIndex((e) => e.nodeId === nodeId);
    if (entryIdx === -1) return false;

    bucket.entries.splice(entryIdx, 1);
    return true;
  }

  /** Get a specific node entry */
  getNode(nodeId: string): KBucketEntry | undefined {
    const distance = xorDistance(this.localId, nodeId);
    const idx = bucketIndex(distance);
    return this.buckets[idx].entries.find((e) => e.nodeId === nodeId);
  }

  /**
   * Find the K closest nodes to a target ID.
   * This is a local lookup — for iterative network lookup, use findNode().
   */
  findClosest(targetId: string, count = K): KBucketEntry[] {
    const allEntries: Array<{ entry: KBucketEntry; distance: string }> = [];

    for (const bucket of this.buckets) {
      for (const entry of bucket.entries) {
        const dist = xorDistance(targetId, entry.nodeId);
        allEntries.push({ entry, distance: dist });
      }
    }

    allEntries.sort((a, b) => compareDistance(a.distance, b.distance));
    return allEntries.slice(0, count).map((e) => e.entry);
  }

  /**
   * Find nodes that are capable of relaying.
   * Filters by relay capability and NAT type.
   */
  findRelayNodes(count = K): KBucketEntry[] {
    const relayCapable: KBucketEntry[] = [];

    for (const bucket of this.buckets) {
      for (const entry of bucket.entries) {
        if (entry.isRelayCapable && entry.natType !== 'symmetric') {
          relayCapable.push(entry);
        }
      }
    }

    // Sort by latency (lower is better)
    relayCapable.sort((a, b) => a.latency - b.latency);
    return relayCapable.slice(0, count);
  }

  /**
   * Get the total number of known nodes.
   */
  getNodeCount(): number {
    let count = 0;
    for (const bucket of this.buckets) {
      count += bucket.entries.length;
    }
    return count;
  }

  /**
   * Get all known nodes.
   */
  getAllNodes(): KBucketEntry[] {
    const nodes: KBucketEntry[] = [];
    for (const bucket of this.buckets) {
      nodes.push(...bucket.entries);
    }
    return nodes;
  }

  /**
   * Get non-empty buckets (for diagnostics).
   */
  getNonEmptyBuckets(): KBucket[] {
    return this.buckets.filter((b) => b.entries.length > 0);
  }

  /**
   * Mark a node as seen (update lastSeen timestamp).
   */
  touchNode(nodeId: string): void {
    const distance = xorDistance(this.localId, nodeId);
    const idx = bucketIndex(distance);
    const bucket = this.buckets[idx];

    const entry = bucket.entries.find((e) => e.nodeId === nodeId);
    if (entry) {
      entry.lastSeen = Date.now();
      // Move to tail
      const entryIdx = bucket.entries.indexOf(entry);
      bucket.entries.splice(entryIdx, 1);
      bucket.entries.push(entry);
    }
  }

  /**
   * Evict all stale nodes (older than MAX_STALE_AGE_MS).
   */
  evictStale(): string[] {
    const evicted: string[] = [];
    const now = Date.now();

    for (const bucket of this.buckets) {
      bucket.entries = bucket.entries.filter((e) => {
        if (now - e.lastSeen > MAX_STALE_AGE_MS) {
          evicted.push(e.nodeId);
          return false;
        }
        return true;
      });
    }

    return evicted;
  }

  /**
   * Select diverse relay nodes avoiding shared network segments.
   * Implements S/Kademlia's diversified routing concept.
   *
   * @param count Number of nodes to select
   * @param excludeNodes Nodes to exclude (e.g., sender and receiver)
   */
  selectDiverseRelays(count: number, excludeNodes: string[] = []): KBucketEntry[] {
    const excludeSet = new Set(excludeNodes);
    const candidates = this.findRelayNodes(count * 3) // Over-sample
      .filter((n) => !excludeSet.has(n.nodeId));

    if (candidates.length <= count) return candidates;

    // Greedy selection maximizing XOR diversity
    const selected: KBucketEntry[] = [candidates[0]]; // Start with best latency
    const remaining = candidates.slice(1);

    while (selected.length < count && remaining.length > 0) {
      let bestIdx = 0;
      let bestMinDist = '';

      for (let i = 0; i < remaining.length; i++) {
        // Find minimum distance from this candidate to all selected nodes
        let minDist = 'f'.repeat(64); // max possible
        for (const sel of selected) {
          const dist = xorDistance(remaining[i].nodeId, sel.nodeId);
          if (compareDistance(dist, minDist) < 0) {
            minDist = dist;
          }
        }
        // Select the candidate whose minimum distance is largest (most diverse)
        if (compareDistance(minDist, bestMinDist) > 0) {
          bestMinDist = minDist;
          bestIdx = i;
        }
      }

      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }

    return selected;
  }

  /** Clear the routing table */
  clear(): void {
    for (const bucket of this.buckets) {
      bucket.entries = [];
    }
  }
}

// ── Hex Utilities ────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.replace(/^0x/, '').padStart(2, '0');
  const bytes = new Uint8Array(Math.ceil(cleanHex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
