/**
 * Spec 016 T5：連線「成形層」確定性模擬。
 *
 * Spec 011 的 1100 組 seed 模擬假設 k-圖已成形、只驗訊息擴散層；7 人 E2E 實證
 * 成形層才是缺口（隨機單邊選擇 → 互選機率化 → offer 無人接聽）。本模擬補上
 * 成形層證明：節點亂序到場、名冊視圖經有界延遲漸進收斂，斷言有限輪內全圖連通。
 *
 * 模型對應：
 * - view 傳播延遲 ＝ Firestore meshIdentities watch push 的到達差
 * - 「兩端各自把對方列為目標」＝ 兩端各自 new MeshConnection（發起方由 uid 序裁決）
 * - 入站應答 ＝ MeshTopologyManager 看到無對應連線的 offer 即建應答端（Spec 016 B）
 * - 確定性目標集 ＝ computeCirculantTargets（Spec 016 A）
 * 誠實邊界：不模擬 WebRTC/ICE 失敗（那屬傳輸品質，與選擇機制正交）。
 */
import { describe, it, expect } from 'vitest';
import { computeCirculantTargets } from '../../src/core/mesh/circulantTopology';

/** 決定性 PRNG（mulberry32）——模擬禁 Math.random，同 seed 必同劇本 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimResult {
  connectedAtRound: number | null;
  unilateralAttempts: number;
}

/**
 * 成形模擬：n 節點、k 目標、maxPropagationDelay 輪的視圖傳播延遲。
 * inboundAccept = Spec 016 B 開關。回傳全圖連通的輪數（null = R_MAX 內未連通）。
 */
function simulateFormation(
  n: number,
  k: number,
  seed: number,
  inboundAccept: boolean
): SimResult {
  const R_MAX = 40;
  const rand = mulberry32(seed);
  const ids = Array.from({ length: n }, (_, j) => `u${String(j).padStart(2, '0')}`);

  // 到場輪次與「x 得知 y 存在」的輪次（到場後 + 0..3 輪傳播延遲）
  const joinRound = new Map(ids.map((id) => [id, Math.floor(rand() * 6)]));
  const knownAt = new Map<string, Map<string, number>>();
  for (const x of ids) {
    const m = new Map<string, number>();
    for (const y of ids) {
      m.set(y, x === y ? joinRound.get(x)! : Math.max(joinRound.get(x)!, joinRound.get(y)!) + Math.floor(rand() * 4));
    }
    knownAt.set(x, m);
  }

  // intent[x] = x 已建立連線物件的對象集合（含發起與應答）
  const intent = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  let unilateralAttempts = 0;

  for (let r = 0; r < R_MAX; r++) {
    // 1. 每個在場節點以當前視圖算目標集，對尚無物件的目標建立物件（發起或等待端）
    for (const x of ids) {
      if (joinRound.get(x)! > r) continue;
      const view = ids.filter((y) => knownAt.get(x)!.get(y)! <= r);
      for (const t of computeCirculantTargets(view, x, k)) {
        if (!intent.get(x)!.has(t)) {
          intent.get(x)!.add(t);
          if (!intent.get(t)!.has(x)) unilateralAttempts++;
        }
      }
    }
    // 2. 入站應答（Spec 016 B）：發起方寫 offer 的下一輪，對向若無物件即建應答端
    if (inboundAccept) {
      for (const x of ids) {
        if (joinRound.get(x)! > r) continue;
        for (const from of ids) {
          if (intent.get(from)!.has(x) && !intent.get(x)!.has(from)) {
            intent.get(x)!.add(from);
          }
        }
      }
    }
    // 3. 連通檢查：邊 = 互有物件
    const allPresent = ids.every((id) => joinRound.get(id)! <= r);
    if (allPresent && isConnectedByIntent(ids, intent)) {
      return { connectedAtRound: r, unilateralAttempts };
    }
  }
  return { connectedAtRound: null, unilateralAttempts };
}

function isConnectedByIntent(ids: string[], intent: Map<string, Set<string>>): boolean {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const a of ids) {
    for (const b of intent.get(a)!) {
      if (intent.get(b)!.has(a)) adj.get(a)!.push(b);
    }
  }
  const seen = new Set([ids[0]!]);
  const queue = [ids[0]!];
  while (queue.length) {
    for (const nb of adj.get(queue.shift()!)!) {
      if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
  }
  return seen.size === ids.length;
}

describe('成形層確定性模擬（Spec 016 T5）', () => {
  it('n=7..10 × 200 seeds：晚到者＋視圖分歧下，有限輪內全圖連通（入站應答開）', () => {
    for (let n = 7; n <= 10; n++) {
      const k = n >= 10 ? 4 : 3;
      for (let seed = 1; seed <= 200; seed++) {
        const { connectedAtRound } = simulateFormation(n, k, seed, true);
        expect(connectedAtRound, `n=${n} k=${k} seed=${seed}`).not.toBeNull();
      }
    }
  });

  it('入站應答關閉時：視圖收斂後互選仍必然成形（確定性互選的自足性）', () => {
    for (let n = 7; n <= 10; n++) {
      const k = n >= 10 ? 4 : 3;
      for (let seed = 1; seed <= 200; seed++) {
        const { connectedAtRound } = simulateFormation(n, k, seed, false);
        // 無入站應答時視圖分歧窗較久才自癒，仍須在 R_MAX 內連通
        expect(connectedAtRound, `n=${n} k=${k} seed=${seed} (inbound off)`).not.toBeNull();
      }
    }
  });

  it('對照組：入站應答把分歧窗的單邊嘗試轉為成形，連通輪數不劣於關閉時', () => {
    let sumOn = 0;
    let sumOff = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const on = simulateFormation(8, 3, seed, true);
      const off = simulateFormation(8, 3, seed, false);
      sumOn += on.connectedAtRound!;
      sumOff += off.connectedAtRound!;
    }
    expect(sumOn).toBeLessThanOrEqual(sumOff);
  });
});
