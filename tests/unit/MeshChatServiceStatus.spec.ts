import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshChatService } from '../../src/core/messaging/MeshChatService';
import { InMemoryChatStorage } from '../../src/core/storage/InMemoryChatStorage';
import type { NeriloStatus } from '../../src/core/messaging/status';

/**
 * Spec 024 T2：引擎狀態透出的行為契約。
 * 不驅動真網路：monkey-patch 兩個既有 getter 模擬內部狀態變化，
 * 驗證的是「翻譯與事件語義」（訂閱即發、同值去抖、退訂停表、cleanup 清理）。
 */
describe('MeshChatService 狀態透出（Spec 024）', () => {
  let svc: MeshChatService;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = new MeshChatService('room-s', 'uid-s', new InMemoryChatStorage());
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  function stub(conn: ReturnType<MeshChatService['getConnectionState']>, enc: ReturnType<MeshChatService['getEncryptionState']>) {
    vi.spyOn(svc, 'getConnectionState').mockReturnValue(conn);
    vi.spyOn(svc, 'getEncryptionState').mockReturnValue(enc);
  }

  it('getStatus：未初始化即可同步取得快照（connecting/pending）', () => {
    // 未 initialize：isInitialized=false → idle → connecting；keyx 未起 → exchanging → pending
    expect(svc.getStatus()).toEqual({ transport: 'connecting', encryption: 'pending' });
  });

  it('onStatus：訂閱當下先收一次；狀態變化才再發；同值不重發', () => {
    stub('connecting', 'exchanging');
    const seen: NeriloStatus[] = [];
    svc.onStatus((s) => seen.push(s));
    expect(seen).toEqual([{ transport: 'connecting', encryption: 'pending' }]);

    vi.advanceTimersByTime(1600); // 三輪輪詢，同值 → 零新事件
    expect(seen).toHaveLength(1);

    stub('connected', 'exchanging'); // P2P 成形，金鑰仍在交換
    vi.advanceTimersByTime(600);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ transport: 'p2p', encryption: 'pending' });

    stub('connected', 'encrypted'); // 金鑰就緒
    vi.advanceTimersByTime(600);
    expect(seen[2]).toEqual({ transport: 'p2p', encryption: 'ready' });
  });

  it('多訂閱者各自在訂閱當下收快照，變化時全體收到', () => {
    stub('connected', 'encrypted');
    const a: NeriloStatus[] = [];
    const b: NeriloStatus[] = [];
    svc.onStatus((s) => a.push(s));
    vi.advanceTimersByTime(600);
    svc.onStatus((s) => b.push(s)); // 晚訂閱也立刻拿到現狀
    expect(b).toEqual([{ transport: 'p2p', encryption: 'ready' }]);

    stub('failed', 'encrypted');
    vi.advanceTimersByTime(600);
    expect(a[a.length - 1]).toEqual({ transport: 'offline', encryption: 'ready' });
    expect(b[b.length - 1]).toEqual({ transport: 'offline', encryption: 'ready' });
  });

  it('全部退訂後輪詢停止；cleanup 清掉計時器與監聽器（重進房不殘留）', async () => {
    stub('connecting', 'exchanging');
    const seen: NeriloStatus[] = [];
    const off = svc.onStatus((s) => seen.push(s));
    off();
    stub('connected', 'encrypted');
    vi.advanceTimersByTime(2000);
    expect(seen).toHaveLength(1); // 退訂後不再收

    svc.onStatus((s) => seen.push(s)); // 再訂閱要能重啟輪詢
    stub('failed', 'plaintext');
    vi.advanceTimersByTime(600);
    expect(seen[seen.length - 1]).toEqual({ transport: 'offline', encryption: 'degraded' });

    await svc.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('監聽器拋錯不擊落其他監聽器（比照既有 listener 慣例）', () => {
    stub('connecting', 'exchanging');
    const seen: NeriloStatus[] = [];
    svc.onStatus(() => { throw new Error('boom'); });
    svc.onStatus((s) => seen.push(s));
    stub('connected', 'encrypted');
    vi.advanceTimersByTime(600);
    expect(seen[seen.length - 1]).toEqual({ transport: 'p2p', encryption: 'ready' });
  });
});
