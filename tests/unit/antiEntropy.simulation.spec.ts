/**
 * antiEntropy 確定性模擬（deterministic simulation，harden-tests 黃金標準）
 *
 * FoundationDB/TigerBeetle 流派：把真協議（computeDigest/normalizeDigest/peerLacks）
 * 跑在受控模擬網路，注入隨機——訊息注入點、對帳配對順序、丟包、網路分割——
 * 用「固定 seed」重現。斷言核心不變量：
 *
 *   連通圖上，週期對帳終將使每個節點持有「全體訊息的聯集」（無永久遺失 =
 *   最終一致；store 以 (sender,seq) 為鍵，結構上不可能重複 = exactly-once）。
 *
 * 掃數百個 seed 探索狀態空間；任一 seed 不收斂即印出該 seed（可重現除錯）。
 * 反向對照（斷開的圖不收斂）證明此測試會偵測「不收斂」，非套套邏輯。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { computeDigest, normalizeDigest, peerLacks } from '../../src/core/mesh/antiEntropy';
import type { GossipMessage } from '../../src/types';

// GossipMessage 對收斂性只有 (senderId, seq) 有意義；其餘給最小值
function msg(senderId: string, seq: number): GossipMessage {
  return {
    roomId: 'sim',
    senderId,
    pubKey: 'x',
    seq,
    timestamp: seq,
    content: `${senderId}-${seq}`,
    ttl: 1,
    signature: 'sig',
  } as GossipMessage;
}

/** 固定 seed PRNG（mulberry32）——確定性、可重現 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模擬節點：真 antiEntropy 函數驅動的 store + 對帳 */
class SimNode {
  store = new Map<string, Map<number, GossipMessage>>();
  put(m: GossipMessage): void {
    let seqs = this.store.get(m.senderId);
    if (!seqs) this.store.set(m.senderId, (seqs = new Map()));
    seqs.set(m.seq, m);
  }
  /** 把「對方（依其 digest）缺、我有」的訊息補給 peer——鏡射 handleDigest 核心 */
  fillTo(peer: SimNode): void {
    const theirs = normalizeDigest(peer.digest());
    if (!theirs) return;
    for (const [sender, seqs] of this.store)
      for (const [seq, m] of seqs) if (peerLacks(theirs, sender, seq)) peer.put(m);
  }
  digest() {
    return computeDigest(this.store, new Map());
  }
  keys(): Set<string> {
    const k = new Set<string>();
    for (const [s, seqs] of this.store) for (const seq of seqs.keys()) k.add(`${s}:${seq}`);
    return k;
  }
}

const eqSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 一次模擬：N 節點、注入 M 訊息、在連通圖上隨機對帳（含丟包），跑到收斂或逾輪。
 * @returns { converged, rounds, allKeys }
 */
function runSim(
  seed: number,
  opts: { nodes: number; messages: number; lossProb: number; maxRounds: number; connected?: boolean },
): { converged: boolean; rounds: number; expected: Set<string> } {
  const rng = mulberry32(seed);
  const pick = (n: number) => Math.floor(rng() * n);
  const nodes = Array.from({ length: opts.nodes }, () => new SimNode());

  // 注入訊息：每個 sender 的 seq 從 1 遞增；隨機落在某節點（模擬亂序/部分到達）
  const seqOf = new Map<string, number>();
  const expected = new Set<string>();
  for (let i = 0; i < opts.messages; i++) {
    const sender = `N${pick(opts.nodes)}`;
    const seq = (seqOf.get(sender) ?? 0) + 1;
    seqOf.set(sender, seq);
    nodes[pick(opts.nodes)]!.put(msg(sender, seq));
    expected.add(`${sender}:${seq}`);
  }

  // 邊：隨機生成樹保證連通(除非 connected:false 則不加樹，可能斷開)
  const edges: Array<[number, number]> = [];
  if (opts.connected !== false) {
    for (let i = 1; i < opts.nodes; i++) edges.push([pick(i), i]); // 生成樹
  }
  // 額外隨機邊
  for (let i = 0; i < opts.nodes; i++) {
    const j = pick(opts.nodes);
    if (i !== j) edges.push([i, j]);
  }

  for (let round = 0; round < opts.maxRounds; round++) {
    // 隨機打亂邊順序，逐邊雙向對帳，依 lossProb 隨機丟一個方向
    const order = [...edges].sort(() => rng() - 0.5);
    for (const [x, y] of order) {
      if (rng() >= opts.lossProb) nodes[x]!.fillTo(nodes[y]!);
      if (rng() >= opts.lossProb) nodes[y]!.fillTo(nodes[x]!);
    }
    if (nodes.every((n) => eqSet(n.keys(), expected))) return { converged: true, rounds: round + 1, expected };
  }
  return { converged: false, rounds: opts.maxRounds, expected };
}

describe('antiEntropy 確定性模擬', () => {
  it('300 個 seed：連通圖 + 30% 丟包下，全員必收斂到聯集', () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const r = runSim(seed, { nodes: 5, messages: 20, lossProb: 0.3, maxRounds: 40 });
      if (!r.converged) failures.push(seed);
    }
    // 任一 seed 不收斂就印出來（可重現）
    expect(failures, `不收斂的 seed（可用該 seed 重現）: ${failures.join(',')}`).toEqual([]);
  });

  it('高丟包（60%）仍收斂，只是需要更多輪', () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const r = runSim(seed, { nodes: 4, messages: 12, lossProb: 0.6, maxRounds: 80 });
      if (!r.converged) failures.push(seed);
    }
    expect(failures, `seed: ${failures.join(',')}`).toEqual([]);
  });

  it('分割後癒合：斷開兩組先各自一致，加橋後全員一致', () => {
    // 手動：2 組 {0,1} {2,3}，先組內對帳，再加橋 1-2
    const nodes = [new SimNode(), new SimNode(), new SimNode(), new SimNode()];
    nodes[0]!.put(msg('N0', 1));
    nodes[3]!.put(msg('N3', 1));
    const expected = new Set(['N0:1', 'N3:1']);

    // 分割期：只組內對帳 → 不會全員一致
    for (let r = 0; r < 5; r++) {
      nodes[0]!.fillTo(nodes[1]!); nodes[1]!.fillTo(nodes[0]!);
      nodes[2]!.fillTo(nodes[3]!); nodes[3]!.fillTo(nodes[2]!);
    }
    expect(eqSet(nodes[0]!.keys(), expected)).toBe(false); // 分割下不該全一致

    // 癒合：加橋 1-2，再對帳
    for (let r = 0; r < 5; r++) {
      nodes[0]!.fillTo(nodes[1]!); nodes[1]!.fillTo(nodes[0]!);
      nodes[1]!.fillTo(nodes[2]!); nodes[2]!.fillTo(nodes[1]!);
      nodes[2]!.fillTo(nodes[3]!); nodes[3]!.fillTo(nodes[2]!);
    }
    for (const n of nodes) expect(eqSet(n.keys(), expected)).toBe(true);
  });

  it('反向對照（誠實）：完全斷開的孤立節點不收斂——證明測試會偵測不收斂', () => {
    // connected:false 且沒額外邊碰到某節點時，孤立節點收不到 → 不收斂
    let sawNonConvergence = false;
    for (let seed = 1; seed <= 50; seed++) {
      const r = runSim(seed, { nodes: 6, messages: 10, lossProb: 0, maxRounds: 30, connected: false });
      if (!r.converged) { sawNonConvergence = true; break; }
    }
    expect(sawNonConvergence, '斷開圖竟然全收斂 → 測試邏輯有問題(套套邏輯)').toBe(true);
  });
});
