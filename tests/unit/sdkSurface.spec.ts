import { describe, it, expect } from 'vitest';
// 只從 SDK 公開出口 import——鎖住「第三方拿到的穩定表面」：門面 + 純 reducer + 記憶體
// 參考 adapter + 型別，全數不需 Firebase（barrel 靜態圖無 firebase，見 ADR-0025 P3）。
import {
  NeriloClient,
  InMemorySignalingHub,
  InMemorySignalingTransport,
  InMemoryRoomDirectoryHub,
  InMemoryRoomDirectory,
  InMemoryChatStorage,
  applyRead,
  readCount,
  orderKeyOf,
  applyReaction,
  type IChatEngine,
  type ChatMessage,
} from '../../src/sdk';
// turnkey 工廠在 subpath（架構收斂 2026-07）：主 barrel 保持純契約、型別表面乾淨
import { createChatClient, createFirestoreSignaling } from '../../src/sdk/firestore';

describe('SDK 公開表面（P3 publishable surface）', () => {
  it('barrel 匯出門面/純函式/記憶體 adapter/型別，全可用（無 Firebase）', () => {
    expect(typeof NeriloClient).toBe('function');
    expect(typeof applyRead).toBe('function');
    expect(typeof readCount).toBe('function');
    expect(typeof orderKeyOf).toBe('function');
    expect(typeof applyReaction).toBe('function');
  });

  it('subpath 匯出 createFirestoreSignaling：同步回傳 transport，且建構當下不載 Firestore（Spec 015 T2）', () => {
    const factory = createFirestoreSignaling();
    const t = factory('room-1', 'ch-a');
    // SignalingFactory 契約是同步的——延遲載入不得把它變成 Promise
    expect(typeof t.subscribe).toBe('function');
    expect(typeof t.send).toBe('function');
    expect(typeof t.cleanupOwn).toBe('function');
    // 只造不用 → 不該碰到 Firestore（否則沒有 Firebase 設定的環境會炸在這裡）
    expect(() => factory('room-2', 'ch-b')).not.toThrow();
  });

  it('三顆記憶體參考後端可獨立運作（signaling / directory / storage）', async () => {
    // signaling round-trip
    const sig = new InMemorySignalingHub();
    const a = new InMemorySignalingTransport(sig, 'r', 'ch');
    const got: unknown[] = [];
    new InMemorySignalingTransport(sig, 'r', 'ch').subscribe(0, (d) => got.push(d));
    await a.send({ from: 'a', type: 'offer', createdAt: 1 });
    expect(got).toHaveLength(1);

    // directory 發現
    const dirHub = new InMemoryRoomDirectoryHub();
    await new InMemoryRoomDirectory(dirHub, 'r', 'uid-a').registerIdentity({ userId: 'ua', pubKey: 'p' });
    const snap = await new InMemoryRoomDirectory(dirHub, 'r', 'uid-b').getSnapshot();
    expect(snap.meshIdentities['uid-a']?.userId).toBe('ua');

    // storage round-trip
    const store = new InMemoryChatStorage();
    const msg: ChatMessage = { messageId: 'm1', from: 'ua', content: 'hi', timestamp: 1 };
    await store.saveChatMessage(msg, 'r');
    await store.saveChatMessage(msg, 'r'); // 同 id 去重
    expect(await store.getChatMessages('r')).toHaveLength(1);
  });

  it('NeriloClient 只靠 IChatEngine 契約即可跑（不依賴任何後端）', async () => {
    const noop = () => () => {};
    const engine: IChatEngine = {
      initialize: async () => {},
      cleanup: async () => {},
      getMeshUserId: () => 'me',
      sendMessage: async () => 'id-1',
      onMessage: noop,
      loadHistory: async () => [],
      sendReaction: async () => {},
      onReaction: noop,
      sendRead: async () => {},
      onRead: noop,
      sendTyping: async () => {},
      onTyping: noop,
      // Spec 024：狀態是 0.10.0 起的必要契約——自帶引擎必須實作
      getStatus: () => ({ transport: 'p2p', encryption: 'ready' }),
      onStatus: (l) => { l({ transport: 'p2p', encryption: 'ready' }); return () => {}; },
    };
    const client = new NeriloClient(engine);
    await client.connect();
    expect(client.userId).toBe('me');
    expect(await client.sendMessage('hi')).toBe('id-1');
    // 狀態面（Spec 024）：快照與訂閱（訂閱當下先收一次）皆走公開表面
    expect(client.status).toEqual({ transport: 'p2p', encryption: 'ready' });
    const seen: unknown[] = [];
    client.onStatus((s) => seen.push(s));
    expect(seen).toEqual([{ transport: 'p2p', encryption: 'ready' }]);
    await client.dispose();
  });

  it('createChatClient 注入全記憶體後端 → 建出完整引擎（不需 Firebase）', async () => {
    const sigHub = new InMemorySignalingHub();
    const dirHub = new InMemoryRoomDirectoryHub();
    const client = await createChatClient({
      roomId: 'room-x',
      userId: 'uid-x',
      signaling: (r, ch) => new InMemorySignalingTransport(sigHub, r, ch),
      directory: new InMemoryRoomDirectory(dirHub, 'room-x', 'uid-x'),
      storage: new InMemoryChatStorage(),
    });
    // 建構成功即證明 MeshChatService 整條靜態圖可在無 Firebase 下載入/建構
    // （connect() 需要瀏覽器 WebRTC，node 環境不驅動）。
    expect(client).toBeInstanceOf(NeriloClient);
  });
});
