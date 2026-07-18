/**
 * ADR-0023 P2-②c：GossipMessageHandler 的 keyx 消費 + 密文顯示接線
 * - 收到 channel:'keyx' 且封給自己 → 開出房間金鑰入環，之後同 epoch 密文可顯示還原
 * - keyx 不進聊天顯示（不觸發 message listener）
 * - 封給別人的 keyx / 無 ECDH 私鑰 → 不安裝金鑰、不顯示、不炸
 * - 金鑰環按信封 epoch 選鑰（輪替後仍能解舊 epoch 歷史密文）
 */
import { describe, it, expect, vi } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import {
  generateRoomKey,
  sealRoomKeyForMember,
} from '../../src/core/mesh/RoomKeyDistribution';
import { encryptRecordContent } from '../../src/core/mesh/RecordCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage, KeyxRecordPayload } from '../../src/types';

async function ecdhPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
    'deriveKey',
  ]) as Promise<CryptoKeyPair>;
}
async function spkiB64(k: CryptoKey): Promise<string> {
  return arrayBufferToBase64(await crypto.subtle.exportKey('spki', k));
}

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
      deriveUserId: vi.fn().mockResolvedValue('producer'),
    },
    security: {
      signMessage: vi.fn().mockResolvedValue('sig'),
      importPublicKey: vi.fn().mockResolvedValue({} as CryptoKey),
      verifyMessage: vi.fn().mockResolvedValue(true),
    },
  };
}

/** handler 的本機 userId（= keyx forMember 比對對象） */
const ME = 'me-user';

function makeHandler(m = makeMocks()) {
  return {
    handler: new GossipMessageHandler(
      'room-r', ME,
      m.identity as never, m.security as never, m.topology as never,
    ),
    mocks: m,
  };
}

/** 造一則已簽章的 keyx wire 訊息（producer 送、封給 forMember 們） */
function keyxWire(payload: KeyxRecordPayload, seq = 1): GossipMessage {
  return {
    roomId: 'room-r',
    senderId: 'producer',
    pubKey: 'producer-pk',
    seq,
    sessionEpoch: 1,
    timestamp: Date.now(),
    content: JSON.stringify(payload),
    ttl: 8,
    signature: 'sig',
    channel: 'keyx',
  };
}
function chatWire(content: string, seq = 2): GossipMessage {
  return {
    roomId: 'room-r',
    senderId: 'producer',
    pubKey: 'producer-pk',
    seq,
    sessionEpoch: 1,
    timestamp: Date.now(),
    content,
    ttl: 8,
    signature: 'sig',
  };
}

async function buildKeyx(
  roomKey: CryptoKey,
  forMember: string,
  epoch: number,
  producer: CryptoKeyPair,
  recipientPub: CryptoKey
): Promise<KeyxRecordPayload> {
  const sealed = await sealRoomKeyForMember(
    roomKey, forMember, epoch, producer.privateKey, recipientPub
  );
  return { v: 'keyx1', producerEcdh: await spkiB64(producer.publicKey), keys: [sealed] };
}

describe('P2-②c：GossipMessageHandler keyx 消費', () => {
  it('收到封給自己的 keyx → 安裝金鑰；不進聊天顯示', async () => {
    const producer = await ecdhPair();
    const me = await ecdhPair();
    const roomKey = await generateRoomKey();
    const payload = await buildKeyx(roomKey, ME, 0, producer, me.publicKey);

    const { handler } = makeHandler();
    handler.setKeyxPrivateKey(me.privateKey);
    const shown: string[] = [];
    handler.onMessage((msg) => shown.push(msg.content));

    await handler.handleReceivedMessage(keyxWire(payload), 'n1');

    expect(shown).toHaveLength(0); // keyx 不顯示
    expect(handler.getMaxKnownEpoch()).toBe(0); // 金鑰已入環

    // 之後同 epoch 密文 → 顯示還原
    const ct = await encryptRecordContent('房內密語', roomKey, 0);
    await handler.handleReceivedMessage(chatWire(ct), 'n1');
    expect(shown).toEqual(['房內密語']);
  });

  it('封給別人的 keyx → 不安裝金鑰、不顯示（拿到的密文顯示佔位）', async () => {
    const producer = await ecdhPair();
    const other = await ecdhPair();
    const me = await ecdhPair();
    const roomKey = await generateRoomKey();
    // 封給 'someone-else'，不是 ME
    const payload = await buildKeyx(roomKey, 'someone-else', 0, producer, other.publicKey);

    const { handler } = makeHandler();
    handler.setKeyxPrivateKey(me.privateKey);
    const shown: string[] = [];
    handler.onMessage((msg) => shown.push(msg.content));

    await handler.handleReceivedMessage(keyxWire(payload), 'n1');
    expect(handler.getMaxKnownEpoch()).toBe(-1); // 沒我的份 → 未安裝

    const ct = await encryptRecordContent('看不到', roomKey, 0);
    await handler.handleReceivedMessage(chatWire(ct), 'n1');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('🔒');
    expect(shown[0]).not.toContain('看不到');
  });

  it('無 ECDH 私鑰（不參與密文化）：keyx 略過、不炸、不顯示', async () => {
    const producer = await ecdhPair();
    const me = await ecdhPair();
    const roomKey = await generateRoomKey();
    const payload = await buildKeyx(roomKey, ME, 0, producer, me.publicKey);

    const { handler } = makeHandler(); // 不呼叫 setKeyxPrivateKey
    const shown: string[] = [];
    handler.onMessage((msg) => shown.push(msg.content));

    await handler.handleReceivedMessage(keyxWire(payload), 'n1');
    expect(shown).toHaveLength(0);
    expect(handler.getMaxKnownEpoch()).toBe(-1);
  });

  it('金鑰環按信封 epoch 選鑰：舊 epoch 密文用舊鑰、新 epoch 用新鑰', async () => {
    const producer = await ecdhPair();
    const me = await ecdhPair();
    const key0 = await generateRoomKey();
    const key1 = await generateRoomKey();

    const { handler } = makeHandler();
    handler.setKeyxPrivateKey(me.privateKey);
    const shown: string[] = [];
    handler.onMessage((msg) => shown.push(msg.content));

    // 先裝 epoch 0，再裝 epoch 1（模擬輪替）
    await handler.handleReceivedMessage(keyxWire(await buildKeyx(key0, ME, 0, producer, me.publicKey), 1), 'n1');
    await handler.handleReceivedMessage(keyxWire(await buildKeyx(key1, ME, 1, producer, me.publicKey), 2), 'n1');
    expect(handler.getMaxKnownEpoch()).toBe(1);

    // epoch 0 的舊密文仍解得開
    const ct0 = await encryptRecordContent('舊時代訊息', key0, 0);
    await handler.handleReceivedMessage(chatWire(ct0, 3), 'n1');
    // epoch 1 的新密文
    const ct1 = await encryptRecordContent('新時代訊息', key1, 1);
    await handler.handleReceivedMessage(chatWire(ct1, 4), 'n1');

    expect(shown).toEqual(['舊時代訊息', '新時代訊息']);
  });
});

/** Spec 012 P2：hydrate 重放 keyx——重載後金鑰環自持久複本重生（明文窗不重開） */
describe('金鑰晚到補顯示（Spec 009×012 合流修復）', () => {
  it('密文先到、keyx 後到：先佔位呈現，金鑰安裝後同 id 重派解密內容', async () => {
    // 跨連結亂序（四線合併 Vue migration-window/rejoin 實測根因）：A 的密文訊息經
    // 直連先到，producer 的 keyx 經另一條連結/對帳晚到——不補顯示的話，佔位字串
    // 會被 UI 與 chatStorage 永久釘住。
    const producer = await ecdhPair();
    const me = await ecdhPair();
    const roomKey = await generateRoomKey();
    const payload = await buildKeyx(roomKey, ME, 0, producer, me.publicKey);

    const { handler } = makeHandler();
    handler.setKeyxPrivateKey(me.privateKey);
    const shown: GossipMessage[] = [];
    handler.onMessage((msg) => shown.push(msg));

    // 密文先到（收端還沒有金鑰）→ 誠實佔位
    const ct = await encryptRecordContent('晚到金鑰的訊息', roomKey, 0);
    await handler.handleReceivedMessage(chatWire(ct, 5), 'n1');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.content).toContain('🔒');

    // keyx 後到 → 金鑰安裝 → 同一則以解密內容重派（UI 以同 id upsert）
    await handler.handleReceivedMessage(keyxWire(payload, 1), 'n1');
    await new Promise((r) => setTimeout(r, 0)); // 補顯示是非阻塞派發
    expect(shown).toHaveLength(2);
    expect(shown[1]!.seq).toBe(5);
    expect(shown[1]!.content).toBe('晚到金鑰的訊息');
  });
});

describe('Spec 012 P2：hydrate 重放 keyx', () => {
  function makePersistence(records: GossipMessage[]) {
    let seq = 0;
    return {
      reserveSeq: vi.fn(async () => ++seq),
      reserveSessionEpoch: vi.fn(async () => Date.now()),
      saveAcceptedEpoch: vi.fn(async () => undefined),
      loadRoom: vi.fn(async () => ({ records, floors: [], acceptedEpochs: [] })),
      saveRecord: vi.fn(async () => undefined),
      evictRecord: vi.fn(async () => undefined),
      listRooms: vi.fn(async () => ['room-r']),
    };
  }

  it('重載後：store 內的 keyx 紀錄重放進金鑰環，密文歷史與新送出皆恢復', async () => {
    const producer = await ecdhPair();
    const me = await ecdhPair();
    const key0 = await generateRoomKey();
    const key1 = await generateRoomKey();
    const persisted: GossipMessage[] = [
      keyxWire(await buildKeyx(key0, ME, 0, producer, me.publicKey), 1),
      keyxWire(await buildKeyx(key1, ME, 1, producer, me.publicKey), 2),
    ];

    const m = makeMocks();
    const handler = new GossipMessageHandler(
      'room-r', ME,
      m.identity as never, m.security as never, m.topology as never,
      null, makePersistence(persisted) as never,
    );
    handler.setKeyxPrivateKey(me.privateKey);
    expect(handler.hasSendKey()).toBe(false);

    await handler.hydrate();

    // 金鑰環重生：最高 epoch 正確（產生方重載不會再重發 epoch 0 造成同代碰撞）
    expect(handler.getMaxKnownEpoch()).toBe(1);
    expect(handler.hasSendKey()).toBe(true);

    // 舊 epoch 歷史密文解得開（顯示路徑）
    const shown: string[] = [];
    handler.onMessage((msg) => shown.push(msg.content));
    const ct0 = await encryptRecordContent('重載前的舊訊息', key0, 0);
    await handler.handleReceivedMessage(chatWire(ct0, 3), 'n1');
    expect(shown).toEqual(['重載前的舊訊息']);

    // 新送出走最新 epoch 密文（不再明文）
    await handler.sendMessage('重載後的新訊息');
    const sent = m.neighbor.send.mock.calls.at(-1)?.[0] as { content: string };
    expect(sent.content).toContain('"v":"nrec1"');
    expect(sent.content).not.toContain('重載後的新訊息');
  });

  it('封給別人的 keyx 重放不安裝金鑰（維持明文相容、不炸）', async () => {
    const producer = await ecdhPair();
    const me = await ecdhPair();
    const other = await ecdhPair();
    const key0 = await generateRoomKey();
    const persisted: GossipMessage[] = [
      keyxWire(await buildKeyx(key0, 'someone-else', 0, producer, other.publicKey), 1),
    ];
    const m = makeMocks();
    const handler = new GossipMessageHandler(
      'room-r', ME,
      m.identity as never, m.security as never, m.topology as never,
      null, makePersistence(persisted) as never,
    );
    handler.setKeyxPrivateKey(me.privateKey);
    await handler.hydrate();
    expect(handler.hasSendKey()).toBe(false);
    expect(handler.getMaxKnownEpoch()).toBe(-1);
  });
});
