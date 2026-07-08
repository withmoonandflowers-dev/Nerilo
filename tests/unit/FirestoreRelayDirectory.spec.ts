/**
 * FirestoreRelayDirectory 單元測試（mock Firestore）— ADR-0023 P4-A
 * 驗 client 端邏輯：announce 寫自己那格、query 的 TTL/exclude/sort/limit/畸形濾除、
 * withdraw 只撤自己。rules（只能寫自己/非匿名）由整合測試 firestore-rules.spec 驗。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/firebase', () => ({ db: {} as any }));

const mockSetDoc = vi.fn().mockResolvedValue(undefined);
const mockDeleteDoc = vi.fn().mockResolvedValue(undefined);
let mockDocs: any[] = [];
const mockGetDocs = vi.fn(async () => ({
  forEach: (cb: (d: any) => void) => mockDocs.forEach((data) => cb({ data: () => data })),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn().mockReturnValue('col-ref'),
  doc: (...a: any[]) => ({ __path: a.slice(1).join('/') }),
  setDoc: (...a: any[]) => mockSetDoc(...a),
  deleteDoc: (...a: any[]) => mockDeleteDoc(...a),
  getDocs: (...a: any[]) => mockGetDocs(...a),
  query: vi.fn().mockReturnValue('q'),
  where: vi.fn().mockReturnValue('w'),
}));

import { FirestoreRelayDirectory } from '../../src/core/relay/FirestoreRelayDirectory';

describe('FirestoreRelayDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocs = [];
  });

  it('announce 寫進 relayDirectory/{ownerUid}，帶 nodeId + ownerUid', async () => {
    const dir = new FirestoreRelayDirectory('uid-me', 30_000, () => 1000);
    await dir.announce({ nodeId: 'node-me', announcedAt: 1000, capacity: 5, regionHint: 'tw' });

    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    const [ref, payload] = mockSetDoc.mock.calls[0];
    expect(ref.__path).toBe('relayDirectory/uid-me');
    expect(payload).toMatchObject({
      nodeId: 'node-me', ownerUid: 'uid-me', announcedAt: 1000, capacity: 5, regionHint: 'tw',
    });
  });

  it('query 映射 + capacity 排序 + excludeNodeId + 濾過期 + 跳畸形', async () => {
    mockDocs = [
      { nodeId: 'low', ownerUid: 'u1', announcedAt: 99_000, capacity: 1 },
      { nodeId: 'high', ownerUid: 'u2', announcedAt: 99_000, capacity: 10 },
      { nodeId: 'me', ownerUid: 'uid-me', announcedAt: 99_000 }, // 自己 → exclude
      { nodeId: 'stale', ownerUid: 'u3', announcedAt: 90_000 },  // < cutoff(95_000) → 濾除
      { ownerUid: 'u4', announcedAt: 99_000 },                   // 無 nodeId → 畸形跳過
    ];
    const dir = new FirestoreRelayDirectory('uid-me', 5_000, () => 100_000);
    const res = await dir.query({ excludeNodeId: 'me' });
    expect(res.map((r) => r.nodeId)).toEqual(['high', 'low']); // capacity 高者前
  });

  it('query limit 截斷', async () => {
    mockDocs = [
      { nodeId: 'a', ownerUid: 'u1', announcedAt: 1000, capacity: 3 },
      { nodeId: 'b', ownerUid: 'u2', announcedAt: 1000, capacity: 2 },
      { nodeId: 'c', ownerUid: 'u3', announcedAt: 1000, capacity: 1 },
    ];
    const dir = new FirestoreRelayDirectory('uid-me', 30_000, () => 1000);
    const res = await dir.query({ limit: 2 });
    expect(res.map((r) => r.nodeId)).toEqual(['a', 'b']);
  });

  it('withdraw 只撤自己那格（忽略 nodeId 參數）', async () => {
    const dir = new FirestoreRelayDirectory('uid-me');
    await dir.withdraw('some-other-node');
    expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    expect(mockDeleteDoc.mock.calls[0][0].__path).toBe('relayDirectory/uid-me');
  });
});
