/**
 * RelayOverlay 測試（發現→registerPeer 同步）
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { RelayOverlay } from '../../src/core/relay/RelayOverlay';
import { InMemoryRelayDirectory } from '../../src/core/relay/RelayDirectory';
import type { RelayManager } from '../../src/core/relay/RelayManager';

function makeFakeRelay() {
  const registered = new Set<string>();
  return {
    registerPeer: vi.fn((id: string) => registered.add(id)),
    unregisterPeer: vi.fn((id: string) => registered.delete(id)),
    _registered: registered,
  };
}

describe('RelayOverlay', () => {
  it('announceSelf 讓自己出現在目錄（別人查得到）', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    const relay = makeFakeRelay();
    const overlay = new RelayOverlay(relay as unknown as RelayManager, dir, 'A', {}, () => 1000);

    await overlay.announceSelf({ reliability: 0.9 }, 5);
    const seen = await dir.query({ excludeNodeId: 'B' });
    expect(seen.map((e) => e.nodeId)).toContain('A');
  });

  it('refresh：把目錄中的候選 registerPeer 進 RelayManager（排除自己）', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    await dir.announce({ nodeId: 'A', announcedAt: 1000 }); // 自己
    await dir.announce({ nodeId: 'C', announcedAt: 1000, metrics: { reliability: 0.9 } });
    await dir.announce({ nodeId: 'D', announcedAt: 1000 });

    const relay = makeFakeRelay();
    const overlay = new RelayOverlay(relay as unknown as RelayManager, dir, 'A', {}, () => 1000);

    const count = await overlay.refresh();
    expect(count).toBe(2);
    expect(overlay.getRegisteredCandidates().sort()).toEqual(['C', 'D']);
    expect(relay.registerPeer).toHaveBeenCalledWith('C', { reliability: 0.9 });
    expect(relay.registerPeer).not.toHaveBeenCalledWith('A', expect.anything());
  });

  it('refresh：目錄中消失的候選 → unregisterPeer', async () => {
    let t = 1000;
    const dir = new InMemoryRelayDirectory(5_000, () => t);
    await dir.announce({ nodeId: 'C', announcedAt: 1000 });

    const relay = makeFakeRelay();
    const overlay = new RelayOverlay(relay as unknown as RelayManager, dir, 'A', {}, () => t);

    await overlay.refresh();
    expect(overlay.getRegisteredCandidates()).toEqual(['C']);

    t = 8_000; // C 過期
    await overlay.refresh();
    expect(relay.unregisterPeer).toHaveBeenCalledWith('C');
    expect(overlay.getRegisteredCandidates()).toEqual([]);
  });

  it('maxCandidates 限制納入數', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    for (const id of ['C', 'D', 'E', 'F']) {
      await dir.announce({ nodeId: id, announcedAt: 1000, capacity: 1 });
    }
    const relay = makeFakeRelay();
    const overlay = new RelayOverlay(relay as unknown as RelayManager, dir, 'A', { maxCandidates: 2 }, () => 1000);

    expect(await overlay.refresh()).toBe(2);
  });

  it('stop 撤回自己的宣告', async () => {
    const dir = new InMemoryRelayDirectory(30_000, () => 1000);
    const relay = makeFakeRelay();
    const overlay = new RelayOverlay(relay as unknown as RelayManager, dir, 'A', {}, () => 1000);
    await overlay.announceSelf();
    await overlay.stop();
    expect((await dir.query()).map((e) => e.nodeId)).not.toContain('A');
  });
});
