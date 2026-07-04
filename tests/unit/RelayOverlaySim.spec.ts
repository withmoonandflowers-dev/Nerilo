/**
 * Relay Overlay 端到端模擬（ADR-0021）
 *
 * 用記憶體多節點模擬證明「全域 relay overlay」的路由邏輯端到端通：
 *   A 想送給 B，但只有 A→C、C→B 可達（模擬 A↔B 直連失敗）。
 *   A 經目錄「發現」C → 註冊為候選 → sendViaRelay → C 中繼 → B 收到。
 *   同時驗證 C 賺到中繼點數。
 *
 * 這證明的是「路由 + 發現 + 計費」的邏輯正確；真實 WebRTC 跨網路傳輸是部署層
 * （attachTransport 注入真送法），需真實多節點驗證，不在單元測試範圍。
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RelayManager } from '../../src/core/relay/RelayManager';
import { RelayOverlay } from '../../src/core/relay/RelayOverlay';
import { InMemoryRelayDirectory } from '../../src/core/relay/RelayDirectory';

/** 記憶體傳輸：把 peerSendFn 的 send(toPeer,data) 路由到目標節點的 handleRelayPacket */
class SimTransport {
  private nodes = new Map<string, RelayManager>();
  register(id: string, mgr: RelayManager): void {
    this.nodes.set(id, mgr);
  }
  sendFnFor(fromId: string) {
    return async (toPeer: string, data: string): Promise<void> => {
      const target = this.nodes.get(toPeer);
      if (target) await target.handleRelayPacket(fromId, data);
      // 目標不在模擬網路 → 丟棄（模擬不可達）
    };
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Relay overlay 端到端模擬：A → C → B', () => {
  let A: RelayManager, B: RelayManager, C: RelayManager;
  let transport: SimTransport;
  let dir: InMemoryRelayDirectory;

  beforeEach(async () => {
    const NOW = 1_000_000;
    dir = new InMemoryRelayDirectory(60_000, () => NOW);
    transport = new SimTransport();

    A = new RelayManager({ localNodeId: 'A', roomId: 'r', enableCoverTraffic: false });
    B = new RelayManager({ localNodeId: 'B', roomId: 'r', enableCoverTraffic: false });
    C = new RelayManager({ localNodeId: 'C', roomId: 'r', enableCoverTraffic: false });
    await A.initialize();
    await B.initialize();
    await C.initialize();

    for (const [id, m] of [['A', A], ['B', B], ['C', C]] as const) {
      transport.register(id, m);
      m.setPeerSendFunction(transport.sendFnFor(id));
    }
  });

  it('A 經目錄發現 C、中繼送達 B，且 C 賺到點數', async () => {
    // C 宣告可中繼（好指標，確保通過 minRelayScore）
    const cOverlay = new RelayOverlay(C, dir, 'C', {}, () => 1_000_000);
    await cOverlay.announceSelf(
      { reliability: 0.95, avgLatency: 20, bandwidth: 5000, uptimeRatio: 0.95 },
      10
    );

    // A 刷新 overlay → 發現並註冊 C 為候選中繼
    const aOverlay = new RelayOverlay(A, dir, 'A', {}, () => 1_000_000);
    const registeredCount = await aOverlay.refresh();
    expect(registeredCount).toBe(1);
    expect(aOverlay.getRegisteredCandidates()).toEqual(['C']);

    // B 收訊接收器
    let deliveredPayload: Uint8Array | null = null;
    B.onMessageDelivery((_mid, payload) => {
      deliveredPayload = payload;
    });

    // C 賺點事件
    let cEarnedBytes = 0;
    C.on('relay:credit-earned', (e) => {
      cEarnedBytes += typeof e.data.bytes === 'number' ? e.data.bytes : 0;
    });

    // A 經中繼送給 B
    const payload = new TextEncoder().encode('hello B via C');
    const ok = await A.sendViaRelay('msg-1', payload, 'B');
    await flush();

    expect(ok).toBe(true);
    expect(deliveredPayload).not.toBeNull();
    expect(new TextDecoder().decode(deliveredPayload!)).toBe('hello B via C');
    expect(cEarnedBytes).toBeGreaterThan(0); // C 因中繼賺到點數
  });

  it('沒有候選中繼時退回直送：B 仍收到，但 C 不經手、不賺點', async () => {
    // A 不刷新 overlay → 無中繼候選 → sendViaRelay 退回直接送給 target
    let delivered: Uint8Array | null = null;
    B.onMessageDelivery((_mid, payload) => {
      delivered = payload;
    });
    let cEarned = 0;
    C.on('relay:credit-earned', (e) => {
      cEarned += typeof e.data.bytes === 'number' ? e.data.bytes : 0;
    });

    const ok = await A.sendViaRelay('msg-2', new TextEncoder().encode('direct'), 'B');
    await flush();

    expect(ok).toBe(true); // 直送成功
    expect(delivered).not.toBeNull();
    expect(new TextDecoder().decode(delivered!)).toBe('direct');
    expect(cEarned).toBe(0); // C 沒被當中繼，沒賺點
  });
});
