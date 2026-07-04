/**
 * RelayDirectory 測試（overlay 發現層）
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { InMemoryRelayDirectory } from '../../src/core/relay/RelayDirectory';

describe('InMemoryRelayDirectory', () => {
  it('announce → query 找得到；excludeNodeId 濾除自己', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    await dir.announce({ nodeId: 'A', announcedAt: 1000 });
    await dir.announce({ nodeId: 'B', announcedAt: 1000 });

    const all = await dir.query();
    expect(all.map((e) => e.nodeId).sort()).toEqual(['A', 'B']);

    const exceptA = await dir.query({ excludeNodeId: 'A' });
    expect(exceptA.map((e) => e.nodeId)).toEqual(['B']);
  });

  it('過期宣告被濾除（TTL）', async () => {
    let t = 1000;
    const dir = new InMemoryRelayDirectory(5_000, () => t);
    await dir.announce({ nodeId: 'C', announcedAt: 1000 });

    t = 4_000; // 未過期
    expect((await dir.query()).length).toBe(1);

    t = 7_000; // 超過 5s TTL
    expect((await dir.query()).length).toBe(0);
  });

  it('withdraw 移除宣告', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    await dir.announce({ nodeId: 'C', announcedAt: 1000 });
    await dir.withdraw('C');
    expect((await dir.query()).length).toBe(0);
  });

  it('重複 announce = 續期（更新 announcedAt）', async () => {
    let t = 1000;
    const dir = new InMemoryRelayDirectory(5_000, () => t);
    await dir.announce({ nodeId: 'C', announcedAt: 1000 });

    t = 4_000;
    await dir.announce({ nodeId: 'C', announcedAt: 4_000 }); // 續期

    t = 8_000; // 距上次續期 4s < 5s TTL
    expect((await dir.query()).length).toBe(1);
  });

  it('capacity 高者排前 + limit 截斷', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    await dir.announce({ nodeId: 'low', announcedAt: 1000, capacity: 1 });
    await dir.announce({ nodeId: 'high', announcedAt: 1000, capacity: 10 });
    await dir.announce({ nodeId: 'mid', announcedAt: 1000, capacity: 5 });

    const top2 = await dir.query({ limit: 2 });
    expect(top2.map((e) => e.nodeId)).toEqual(['high', 'mid']);
  });
});
