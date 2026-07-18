/**
 * Spec 009 conformance 測試向量（C1-C7）——protocol 軌符合性判準
 *
 * 目標讀者是「用別的語言寫相容實作的人」：每個向量都是
 * 「給定輸入 → 必須接受/拒絕/產出什麼」的可執行判準，全程用真密碼學
 * （ECDSA P-256 簽章、真 SecurityManager、真 GossipMessageHandler 接受規則），
 * 不用 mock 簽章。他人實作跑得過等價向量即相容。
 *
 * 向量定義同步登載於 specs/009-session-epoch-replay/spec.md 第 6 節 V6。
 */
import { describe, it, expect, vi } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import { SecurityManager } from '../../src/core/mesh/SecurityManager';
import { IdentityManager } from '../../src/core/mesh/IdentityManager';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage } from '../../src/types';

// ── 真簽章工具 ──────────────────────────────────────────────────────────────

const security = new SecurityManager();
const identityUtil = new IdentityManager(); // 只用 deriveUserId（純函數性質）

async function makeSender() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
  const senderId = await identityUtil.deriveUserId(kp.publicKey);
  return { kp, pubKey, senderId };
}

type Sender = Awaited<ReturnType<typeof makeSender>>;

async function signedMsg(
  sender: Sender,
  over: Partial<Omit<GossipMessage, 'signature'>> = {},
): Promise<GossipMessage> {
  const unsigned: Omit<GossipMessage, 'signature'> = {
    roomId: 'conf-room',
    senderId: sender.senderId,
    pubKey: sender.pubKey,
    seq: 1,
    sessionEpoch: 1,
    timestamp: Date.now(),
    content: 'conformance',
    ttl: 2,
    ...over,
  };
  const signature = await security.signMessage(unsigned, sender.kp.privateKey);
  return { ...unsigned, signature };
}

function makeReceiver() {
  const neighbor = {
    getId: vi.fn().mockReturnValue('probe'),
    getState: vi.fn().mockReturnValue('connected'),
    send: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
  };
  const topology = {
    getNeighbors: vi.fn().mockReturnValue([neighbor]),
    getGossipConfig: vi.fn().mockReturnValue({ fanout: 2, ttl: 8 }),
  };
  const handler = new GossipMessageHandler(
    'conf-room',
    'receiver-local',
    identityUtil as never, // 真 deriveUserId：pubKey↔senderId 綁定用真雜湊
    security,
    topology as never,
  );
  const shown: GossipMessage[] = [];
  handler.onMessage((m) => shown.push(m));
  return { handler, shown, neighbor };
}

describe('Spec 009 conformance（C1-C7，真簽章）', () => {
  it('C1 舊會話重放必須拒收：已知現行代後，較低 sessionEpoch 的合法簽章訊息不入 store、不上 UI、不轉發', async () => {
    const s = await makeSender();
    const { handler, shown, neighbor } = makeReceiver();

    await handler.handleReceivedMessage(await signedMsg(s, { sessionEpoch: 5, seq: 1 }), 'n1');
    expect(shown).toHaveLength(1);
    neighbor.send.mockClear();

    // 舊會話錄音重放（簽章完全合法）
    await handler.handleReceivedMessage(
      await signedMsg(s, { sessionEpoch: 3, seq: 9, content: 'old-session' }),
      'n1',
    );
    expect(shown).toHaveLength(1); // 不上 UI
    expect(neighbor.send).not.toHaveBeenCalled(); // 不轉發
    await handler.handleDigest({}, neighbor as never); // 不入 store：補送不含 seq 9
    const filled = neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
    expect(filled).toEqual([1]);
  });

  it('C2 補送輸入必須接受：現行代、30 分鐘前 timestamp、ttl=0 的補送恰好一次呈現', async () => {
    const s = await makeSender();
    const { handler, shown } = makeReceiver();

    const fill = await signedMsg(s, {
      sessionEpoch: 7, seq: 1, ttl: 0,
      timestamp: Date.now() - 30 * 60 * 1000,
    });
    await handler.handleReceivedMessage(fill, 'n1');
    expect(shown).toHaveLength(1); // 接受（epoch 門檻不是 wall-clock 門檻）
    await handler.handleReceivedMessage({ ...fill }, 'n2');
    expect(shown).toHaveLength(1); // 重複補送去重
  });

  it('C3 預佔槽位失效：舊代 (E1, seq1) 先佔，現行代 (E5, seq1) 仍必須被接受', async () => {
    const s = await makeSender();
    const { handler, shown } = makeReceiver();

    await handler.handleReceivedMessage(
      await signedMsg(s, { sessionEpoch: 1, seq: 1, content: 'stale' }),
      'attacker',
    );
    await handler.handleReceivedMessage(
      await signedMsg(s, { sessionEpoch: 5, seq: 1, content: 'genuine' }),
      'n1',
    );
    expect(shown.map((m) => m.content)).toEqual(['stale', 'genuine']);
    // 採納後續灌舊代 → 拒
    await handler.handleReceivedMessage(
      await signedMsg(s, { sessionEpoch: 1, seq: 2 }),
      'attacker',
    );
    expect(shown).toHaveLength(2);
  });

  it('C4 sessionEpoch 有簽章保護：竄改 epoch 的訊息驗簽必敗、必須拒收', async () => {
    const s = await makeSender();
    const { handler, shown } = makeReceiver();

    const genuine = await signedMsg(s, { sessionEpoch: 3, seq: 1 });
    await handler.handleReceivedMessage({ ...genuine, sessionEpoch: 99 }, 'n1');
    expect(shown).toHaveLength(0);
  });

  it('C5 缺 sessionEpoch（v1 舊版訊息）：整則拒收並發出版本不合確證', async () => {
    const s = await makeSender();
    const { handler, shown } = makeReceiver();
    const mismatch = vi.fn();
    handler.onProtocolMismatch(mismatch);

    const legacy = await signedMsg(s);
    delete (legacy as Partial<GossipMessage>).sessionEpoch;
    await handler.handleReceivedMessage(legacy, 'n1');
    expect(shown).toHaveLength(0);
    expect(mismatch).toHaveBeenCalledWith('n1');
  });

  it('C6 digest v2 形狀：缺 epoch 的 v1 digest fail-closed 整份忽略；v2 digest 依代際規則補送', async () => {
    const s = await makeSender();
    const { handler, neighbor } = makeReceiver();
    await handler.handleReceivedMessage(await signedMsg(s, { sessionEpoch: 4, seq: 1 }), 'n1');
    neighbor.send.mockClear();

    // v1 digest（缺 epoch）→ 不補送任何東西
    await handler.handleDigest({ [s.senderId]: { floor: 1, max: 0, missing: [] } }, neighbor as never);
    expect(neighbor.send).not.toHaveBeenCalled();

    // v2 digest、對方代落後（epoch 2）→ 現行代（4）紀錄全補（推進換代）
    await handler.handleDigest(
      { [s.senderId]: { epoch: 2, floor: 1, max: 9, missing: [] } },
      neighbor as never,
    );
    expect(neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).sessionEpoch)).toEqual([4]);

    // v2 digest、對方代較新（epoch 9）→ 我方過時，不送
    neighbor.send.mockClear();
    await handler.handleDigest(
      { [s.senderId]: { epoch: 9, floor: 1, max: 0, missing: [] } },
      neighbor as never,
    );
    expect(neighbor.send).not.toHaveBeenCalled();
  });

  it('C7 未來時間戳仍一律拒絕（不受 maxAgeMs: null 影響；合法補送只帶過去時間）', async () => {
    const s = await makeSender();
    const { handler, shown } = makeReceiver();
    await handler.handleReceivedMessage(
      await signedMsg(s, { sessionEpoch: 1, seq: 1, timestamp: Date.now() + 60_000 }),
      'n1',
    );
    expect(shown).toHaveLength(0);
  });
});
