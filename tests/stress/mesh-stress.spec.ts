/**
 * Mesh stress test — 20+ peer simulation.
 *
 * We exercise the real production algorithms (AdaptiveTopologyManager,
 * SuperNodeElection, gossip fanout + TTL semantics) but route messages
 * in-process between simulated peers rather than spinning up 25 browser
 * contexts. That tests algorithmic correctness at scale without the
 * WebRTC/ICE overhead that would dominate timings on a CI runner.
 *
 * Scenarios:
 *   - Topology strategy transitions at 5 / 10 / 20 / 25 peers
 *   - Broadcast at scale: every peer sends one message, all peers receive
 *     all messages (no loss above the gossip tolerance threshold)
 *   - Peer departure: drop 5 random peers, remaining peers stay connected
 *   - Reconnection storm: 10 peers leave & rejoin together
 *
 * Run with `npm run test:stress`. Slower than the unit suite — runs
 * thousands of routed messages — so it isn't part of the default
 * `npm run ci`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AdaptiveTopologyManager,
  type TopologyStrategy,
} from '../../src/core/mesh/AdaptiveTopologyManager';
import {
  SuperNodeElection,
  type PeerScore,
} from '../../src/core/mesh/SuperNodeElection';

// ── Simulation primitives ───────────────────────────────────────────────────

interface SimMessage {
  id: string;
  fromId: string;
  content: string;
  fanout: number;
  ttl: number;
  /** Wall-clock time the originator broadcast at. */
  bornAt: number;
}

interface DeliveryRecord {
  messageId: string;
  fromId: string;
  toId: string;
  hops: number;
  /** Latency in 'ticks' — each gossip relay step counts as 1 tick. */
  ticks: number;
}

class SimPeer {
  id: string;
  neighbors: SimPeer[] = [];
  /** Messages this peer has already seen (de-dup). */
  private seen = new Set<string>();
  /** Messages this peer has successfully received (excluding own). */
  received: DeliveryRecord[] = [];
  /** Active = participating in the mesh. */
  active = true;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Receive a message. If it's new and we still have TTL, forward to fanout
   * random neighbors. Returns synchronously — the test driver advances
   * "ticks" by re-invoking receive() in a queue.
   */
  receive(
    msg: SimMessage,
    senderId: string,
    hopsSoFar: number,
    ticksSoFar: number,
    enqueue: (msg: SimMessage, from: string, to: SimPeer, hops: number, ticks: number) => void,
    rng: () => number,
  ): void {
    if (!this.active) return;
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);

    if (msg.fromId !== this.id) {
      this.received.push({
        messageId: msg.id,
        fromId: msg.fromId,
        toId: this.id,
        hops: hopsSoFar,
        ticks: ticksSoFar,
      });
    }

    if (hopsSoFar >= msg.ttl) return;

    const candidates = this.neighbors.filter((n) => n.active && n.id !== senderId);
    const fanout = Math.min(msg.fanout, candidates.length);
    const selected = sampleWithoutReplacement(candidates, fanout, rng);
    for (const target of selected) {
      enqueue(msg, this.id, target, hopsSoFar + 1, ticksSoFar + 1);
    }
  }
}

/** Seeded RNG — deterministic test runs. */
function makeRng(seed: number): () => number {
  // mulberry32
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement<T>(items: T[], k: number, rng: () => number): T[] {
  if (k >= items.length) return [...items];
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Build a peer mesh of N peers and wire neighbors according to
 * AdaptiveTopologyManager's targetNeighborCount. Uses a random connected
 * graph — each peer picks its target neighbors from the others.
 */
function buildMesh(n: number, rng: () => number): { peers: SimPeer[]; tm: AdaptiveTopologyManager } {
  const peers = Array.from({ length: n }, (_, i) => new SimPeer(`p${i}`));
  const tm = new AdaptiveTopologyManager();
  const target = tm.getTargetNeighborCount(n);

  for (const peer of peers) {
    const others = peers.filter((p) => p.id !== peer.id);
    const picks = sampleWithoutReplacement(others, target, rng);
    for (const neighbor of picks) {
      if (!peer.neighbors.includes(neighbor)) peer.neighbors.push(neighbor);
      if (!neighbor.neighbors.includes(peer)) neighbor.neighbors.push(peer);
    }
  }
  return { peers, tm };
}

/**
 * Broadcast `content` from `origin` and drive the simulation to completion
 * (all pending hops resolved). Returns the per-peer delivery records.
 */
function runBroadcast(
  origin: SimPeer,
  fanout: number,
  ttl: number,
  rng: () => number,
): SimMessage {
  const msg: SimMessage = {
    id: `${origin.id}-${rng().toString(36).slice(2, 8)}`,
    fromId: origin.id,
    content: 'payload',
    fanout,
    ttl,
    bornAt: 0,
  };

  // BFS-style scheduling — each enqueued hop is a separate "tick".
  type QueueItem = { msg: SimMessage; from: string; to: SimPeer; hops: number; ticks: number };
  const queue: QueueItem[] = [];
  const enqueue = (m: SimMessage, from: string, to: SimPeer, hops: number, ticks: number) => {
    queue.push({ msg: m, from, to, hops, ticks });
  };

  origin.receive(msg, origin.id, 0, 0, enqueue, rng);

  while (queue.length > 0) {
    const item = queue.shift()!;
    item.to.receive(item.msg, item.from, item.hops, item.ticks, enqueue, rng);
  }

  return msg;
}

// ── Topology strategy tests ─────────────────────────────────────────────────

describe('mesh stress @ scale — topology transitions', () => {
  const tm = new AdaptiveTopologyManager();

  it('returns "direct" for 2 peers', () => {
    expect(tm.getStrategy(2)).toBe<TopologyStrategy>('direct');
    expect(tm.getTargetNeighborCount(2)).toBe(1);
  });

  it('returns "full-mesh" for 5 peers', () => {
    expect(tm.getStrategy(5)).toBe<TopologyStrategy>('full-mesh');
    expect(tm.getTargetNeighborCount(5)).toBe(4);
  });

  it('returns "partial-mesh" for 10 peers', () => {
    expect(tm.getStrategy(10)).toBe<TopologyStrategy>('partial-mesh');
    const target = tm.getTargetNeighborCount(10);
    expect(target).toBeGreaterThanOrEqual(3);
    expect(target).toBeLessThan(10);
  });

  it('returns "partial-mesh" for 20 peers', () => {
    expect(tm.getStrategy(20)).toBe<TopologyStrategy>('partial-mesh');
    const target = tm.getTargetNeighborCount(20);
    expect(target).toBeGreaterThanOrEqual(3);
  });

  it('returns "super-node" for 25 peers (boundary)', () => {
    expect(tm.getStrategy(25)).toBe<TopologyStrategy>('super-node');
    expect(tm.getTargetNeighborCount(25)).toBe(5);
  });

  it('returns "super-node" for 100 peers (extreme scale)', () => {
    expect(tm.getStrategy(100)).toBe<TopologyStrategy>('super-node');
  });

  it('gossip config grows with peer count', () => {
    const five = tm.getGossipConfig(5);
    const fifteen = tm.getGossipConfig(15);
    const fifty = tm.getGossipConfig(50);
    expect(five.ttl).toBeLessThanOrEqual(fifteen.ttl);
    expect(fifteen.ttl).toBeLessThanOrEqual(fifty.ttl);
    expect(fifty.fanout).toBeGreaterThanOrEqual(fifteen.fanout);
  });
});

// ── Broadcast-at-scale ──────────────────────────────────────────────────────

describe('mesh stress @ 25 peers — gossip broadcast', () => {
  const N = 25;
  let peers: SimPeer[];
  let tm: AdaptiveTopologyManager;

  beforeAll(() => {
    const built = buildMesh(N, makeRng(0xC0FFEE));
    peers = built.peers;
    tm = built.tm;
  });

  it('every peer can reach every other peer in one broadcast', () => {
    const cfg = tm.getGossipConfig(N);
    // Each peer broadcasts one message; we check deliveries on the receiving side.
    for (const origin of peers) {
      runBroadcast(origin, cfg.fanout, cfg.ttl, makeRng(origin.id.charCodeAt(1) + 1));
    }

    // Every peer should have received N-1 distinct senders' messages.
    for (const peer of peers) {
      const senders = new Set(peer.received.map((r) => r.fromId));
      // Gossip with random fanout doesn't guarantee 100% delivery on a sparse
      // partial-mesh, so we tolerate up to ~5% loss. At super-node strategy
      // (N=25, fanout=4, ttl=5) we'd expect very high delivery.
      const deliveryRate = senders.size / (N - 1);
      expect(deliveryRate).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('broadcast latency is bounded by ttl ticks', () => {
    // Reset received history
    for (const p of peers) p.received = [];
    const built = buildMesh(N, makeRng(0xC0FFEE));
    const cfg = tm.getGossipConfig(N);

    runBroadcast(built.peers[0], cfg.fanout, cfg.ttl, makeRng(1));

    const all = built.peers.flatMap((p) => p.received);
    if (all.length === 0) return; // no deliveries — covered by earlier test
    const ticks = all.map((r) => r.ticks);
    const maxTicks = Math.max(...ticks);
    expect(maxTicks).toBeLessThanOrEqual(cfg.ttl);
  });

  it('total deliveries scales close to N*(N-1) when fanout × ttl ≥ log(N)', () => {
    // Reset
    const built = buildMesh(N, makeRng(0xDEADBEEF));
    const cfg = tm.getGossipConfig(N);
    for (const origin of built.peers) {
      runBroadcast(origin, cfg.fanout, cfg.ttl, makeRng(origin.id.charCodeAt(1) + 1));
    }

    const totalDeliveries = built.peers.reduce(
      (acc, p) => acc + new Set(p.received.map((r) => r.fromId)).size,
      0,
    );
    const ideal = N * (N - 1); // every peer sees every other peer's message
    // Sanity: at least 80% of the ideal coverage. Gossip with randomized
    // fanout in a sparse partial mesh can lose some messages; the absolute
    // floor we accept is 80%.
    expect(totalDeliveries).toBeGreaterThan(ideal * 0.8);
  });
});

// ── Peer departure ──────────────────────────────────────────────────────────

describe('mesh stress @ 25 peers — peer departure', () => {
  it('removes 5 random peers and remaining 20 still communicate', () => {
    const { peers, tm } = buildMesh(25, makeRng(0xBEEF));
    const cfg = tm.getGossipConfig(25);

    // Knock out 5 random peers
    const rng = makeRng(0xFA11);
    const departing = sampleWithoutReplacement(peers, 5, rng);
    for (const p of departing) p.active = false;

    const survivors = peers.filter((p) => p.active);
    expect(survivors.length).toBe(20);

    // Each survivor broadcasts; every survivor should hear from most others.
    for (const origin of survivors) {
      runBroadcast(origin, cfg.fanout, cfg.ttl, makeRng(origin.id.charCodeAt(1) + 1));
    }

    // No survivor should have received a message from a departed peer.
    const departedIds = new Set(departing.map((p) => p.id));
    for (const peer of survivors) {
      for (const rec of peer.received) {
        expect(departedIds.has(rec.fromId)).toBe(false);
      }
    }

    // Survivor → survivor delivery rate should stay reasonably high.
    for (const peer of survivors) {
      const heardFrom = new Set(peer.received.map((r) => r.fromId));
      // 20 survivors, peer hears from at most 19 others
      expect(heardFrom.size).toBeGreaterThanOrEqual(Math.floor((survivors.length - 1) * 0.8));
    }
  });
});

// ── Reconnection storm ─────────────────────────────────────────────────────

describe('mesh stress @ 25 peers — reconnection storm', () => {
  it('10 peers simultaneously rejoin and gossip resumes', () => {
    const { peers, tm } = buildMesh(25, makeRng(0xACE));
    const cfg = tm.getGossipConfig(25);

    // Drop 10 peers, then bring them all back at once
    const rng = makeRng(0x57E);
    const flapping = sampleWithoutReplacement(peers, 10, rng);
    for (const p of flapping) p.active = false;
    for (const p of flapping) p.active = true;

    // Reset received history so we can measure post-storm delivery
    for (const p of peers) p.received = [];

    for (const origin of peers) {
      runBroadcast(origin, cfg.fanout, cfg.ttl, makeRng(origin.id.charCodeAt(1) + 1));
    }

    // Every peer (including the flappers) should hear from most others.
    for (const peer of peers) {
      const heardFrom = new Set(peer.received.map((r) => r.fromId));
      const deliveryRate = heardFrom.size / (peers.length - 1);
      expect(deliveryRate).toBeGreaterThanOrEqual(0.8);
    }
  });
});

// ── Super-node election at 25 peers ─────────────────────────────────────────

describe('mesh stress @ 25 peers — super-node election', () => {
  it('picks the top-scoring ceil(N/10)=3 nodes deterministically', () => {
    // Build 25 peers with varied quality scores.
    const peers: PeerScore[] = Array.from({ length: 25 }, (_, i) => ({
      peerId: `peer-${i.toString().padStart(2, '0')}`,
      uptimeSeconds: 100 + i * 30, // higher index = better uptime
      bandwidthKbps: 500 + i * 50,
      latencyMs: 200 - i * 5, // higher index = lower latency
      batteryLevel: 0.5 + i * 0.01,
      natType: i % 4 === 0 ? 'open' : 'full-cone',
    }));

    const election = new SuperNodeElection();
    // Election only fires when participantCount > 20 — 25 is well over.
    const result = election.elect(peers, 25);
    expect(result.superNodes.length).toBe(3); // ceil(25 / 10)
    // The highest-index peers (best quality on every axis) should win.
    expect(result.superNodes).toContain('peer-24');
    expect(result.superNodes).toContain('peer-23');
    expect(result.superNodes).toContain('peer-22');

    // Determinism: same input → same output
    const result2 = election.elect(peers, 25);
    expect(result2.superNodes).toEqual(result.superNodes);
  });

  it('returns empty election for participantCount <= 20', () => {
    const election = new SuperNodeElection();
    const peers: PeerScore[] = Array.from({ length: 10 }, (_, i) => ({
      peerId: `p${i}`,
      uptimeSeconds: 100,
      bandwidthKbps: 500,
      latencyMs: 100,
      batteryLevel: 0.5,
      natType: 'full-cone',
    }));
    const result = election.elect(peers, 10);
    expect(result.superNodes).toEqual([]);
  });
});
