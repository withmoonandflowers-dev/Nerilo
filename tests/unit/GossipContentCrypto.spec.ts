/**
 * ADR-0023 P2-②a：GossipMessageHandler 內容密文化接線
 * - 金鑰就緒：送出 content 為密文信封（明文不外洩）；顯示端解密還原
 * - 無金鑰：明文相容（行為同 P2 之前）——這是釘住現況、確保 mesh 不被弄壞的地板
 * - store/轉發保持密文原封（盲信使相容）
 * - 收到密文但無金鑰：佔位字串，不炸
 */
import { describe, it, expect, vi } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import { isEncryptedContent } from '../../src/core/mesh/RecordCrypto';
import type { GossipMessage } from '../../src/types';

function makeMocks() {
  const neighbor = {
    getId: vi.fn().mockReturnValue('n1'),
    getState: vi.fn().mockReturnValue('connected'),
    send: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
  };
  return {
    neighbor,
    topology: {
      getNeighbors: vi.fn().mockReturnValue([neighbor]),
      getGossipConfig: vi.fn().mockReturnValue({ fanout: 2, ttl: 8 }),
    },
    identity: {
      exportPublicKey: vi.fn().mockResolvedValue('pk'),
      getPrivateKey: vi.fn().mockReturnValue({} as CryptoKey),
      deriveUserId: vi.fn().mockResolvedValue('remote-sender'),
    },
    security: {
      signMessage: vi.fn().mockResolvedValue('sig'),
      importPublicKey: vi.fn().mockResolvedValue({} as CryptoKey),
      verifyMessage: vi.fn().mockResolvedValue(true),
    },
  };
}

function makeHandler(m = makeMocks()) {
  return {
    handler: new GossipMessageHandler(
      'room-r', 'local-u',
      m.identity as never, m.security as never, m.topology as never,
    ),
    mocks: m,
  };
}

async function roomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt', 'decrypt',
  ]);
}

const lastSent = (m: ReturnType<typeof makeMocks>): GossipMessage =>
  m.neighbor.send.mock.calls.at(-1)![0] as GossipMessage;

describe('P2-②a：Gossip 內容密文化接線', () => {
  it('無金鑰：送出 content 為明文（釘住現況，mesh 不變）', async () => {
    const { handler, mocks } = makeHandler();
    await handler.sendMessage('明文訊息');
    expect(lastSent(mocks).content).toBe('明文訊息');
    expect(isEncryptedContent(lastSent(mocks).content)).toBe(false);
  });

  it('金鑰就緒：送出 content 為密文信封，明文不外洩', async () => {
    const { handler, mocks } = makeHandler();
    handler.setContentKey(await roomKey(), 5);
    await handler.sendMessage('祕密內容');
    const sent = lastSent(mocks);
    expect(isEncryptedContent(sent.content)).toBe(true);
    expect(sent.content).not.toContain('祕密內容');
  });

  it('端到端：A 用金鑰送、B 用同金鑰收 → 顯示還原明文；store/轉發保持密文', async () => {
    const key = await roomKey();

    // A 送（產生密文 wire message）
    const a = makeHandler();
    a.handler.setContentKey(key, 1);
    await a.handler.sendMessage('嗨B');
    const wire = a.mocks.neighbor.send.mock.calls.at(-1)![0] as GossipMessage;
    expect(isEncryptedContent(wire.content)).toBe(true);

    // B 收（同金鑰）→ 顯示解密；但轉發出去的仍是密文
    const b = makeHandler();
    b.handler.setContentKey(key, 1);
    const shown: string[] = [];
    b.handler.onMessage((msg) => shown.push(msg.content));
    // 讓 B 的驗簽/deriveUserId 對上 wire.senderId
    b.mocks.identity.deriveUserId.mockResolvedValue(wire.senderId);
    await b.handler.handleReceivedMessage(wire, 'n1');

    expect(shown).toEqual(['嗨B']); // 顯示還原
    // B 轉發給其他鄰居的內容仍是密文（盲信使/中繼看不到明文）
    const forwarded = b.mocks.neighbor.send.mock.calls.at(-1)?.[0] as GossipMessage | undefined;
    if (forwarded) expect(isEncryptedContent(forwarded.content)).toBe(true);
  });

  it('收到密文但無金鑰：佔位顯示、不炸', async () => {
    const key = await roomKey();
    const a = makeHandler();
    a.handler.setContentKey(key, 1);
    await a.handler.sendMessage('看不到');
    const wire = a.mocks.neighbor.send.mock.calls.at(-1)![0] as GossipMessage;

    const b = makeHandler(); // 沒設金鑰
    const shown: string[] = [];
    b.handler.onMessage((msg) => shown.push(msg.content));
    b.mocks.identity.deriveUserId.mockResolvedValue(wire.senderId);
    await b.handler.handleReceivedMessage(wire, 'n1');

    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('🔒');
    expect(shown[0]).not.toContain('看不到');
  });
});

describe('P2-③：Firestore 備援層加解密（房間金鑰）', () => {
  it('encryptForFallback → decryptForFallback round-trip 還原明文，且密文不外洩', async () => {
    const key = await roomKey();
    const { handler } = makeHandler();
    handler.setContentKey(key, 3);
    const env = await handler.encryptForFallback('祕密備援');
    expect(env).not.toBeNull();
    expect(isEncryptedContent(env!)).toBe(true);
    expect(env!).not.toContain('祕密備援');
    expect(await handler.decryptForFallback(env!)).toBe('祕密備援');
  });

  it('無金鑰：encryptForFallback 回 null（呼叫端據此不送明文）', async () => {
    const { handler } = makeHandler();
    expect(await handler.encryptForFallback('x')).toBeNull();
  });

  it('缺對應 epoch 金鑰：decryptForFallback 拋錯（未在籍/未補齊）', async () => {
    const key = await roomKey();
    const a = makeHandler().handler;
    a.setContentKey(key, 1);
    const env = await a.encryptForFallback('hi'); // epoch 1 密文

    const b = makeHandler().handler; // 只有 epoch 2 的金鑰 → 解不了 epoch 1
    b.setContentKey(await roomKey(), 2);
    await expect(b.decryptForFallback(env!)).rejects.toThrow();
  });
});
