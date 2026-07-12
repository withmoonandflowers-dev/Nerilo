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
  encodeContent,
  decodeContent,
  type IChatEngine,
  type ChatMessage,
} from '../../src/sdk';

describe('SDK 公開表面（P3 publishable surface）', () => {
  it('barrel 匯出門面/純函式/記憶體 adapter/型別，全可用（無 Firebase）', () => {
    expect(typeof NeriloClient).toBe('function');
    expect(typeof applyRead).toBe('function');
    expect(typeof readCount).toBe('function');
    expect(typeof orderKeyOf).toBe('function');
    expect(typeof applyReaction).toBe('function');
    expect(typeof encodeContent).toBe('function');
    expect(typeof decodeContent).toBe('function');
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
    };
    const client = new NeriloClient(engine);
    await client.connect();
    expect(client.userId).toBe('me');
    expect(await client.sendMessage('hi')).toBe('id-1');
    await client.dispose();
  });
});
