/**
 * Spec 029 Q5 現況紀錄（characterization）：一個 CourierServer 實例的請求者狀態範圍。
 *
 * 查證結論（2026-10-03）：
 * - 產品接線（web-vue useCourierNode.start）每個入站 relay 連線建一個 CourierServer，
 *   掛在該連線自己的 P2PChannelBus；relay channelId = 兩個 uid 排序相接，一條 DataChannel 只有一個對端。
 *   所以在產品路徑上，一個實例只服務一個 channelPeerId。
 * - 但 CourierServer 本身不強制這件事：`requester` 是單一欄位，不看 env.from。
 *   若同一個實例收到多個 from 的封包（多工 bus），後到的 IDENTIFY 會覆蓋先到的，
 *   另一個 peer 的 QUOTE 會拿到以對方 nodeId 開出的報價。
 * - 同一通道的同一對端可以再送 IDENTIFY 換成另一個合法身分，現況照收。
 *
 * 下列測試釘住現況，不是期望行為。Spec 029 B1 若改成按 channelPeerId 隔離，
 * 「現況紀錄」區的斷言應改寫成拒絕。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { CourierServer, COURIER_NS, CourierMsgType } from '../../src/core/relay/CourierService';
import type { CourierBus } from '../../src/core/relay/CourierService';
import { CourierStore, DEFAULT_COURIER_CONFIG } from '../../src/core/relay/CourierStore';
import { CourierIOUBook } from '../../src/core/incentive/CourierIOU';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { SignFn } from '../../src/core/incentive/CoSignedReceipt';
import type { P2PEnvelope } from '../../src/types';

interface Node {
  nodeId: string;
  pubKey: string;
  sign: SignFn;
}

async function node(): Promise<Node> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', keys.publicKey));
  return { nodeId: await senderIdFromPubKey(pubKey), pubKey, sign: ecdsaSigner(keys.privateKey) };
}

/** 單一 bus，測試直接以任意 from 注入封包，並記錄 server 的回覆。 */
class RecordingBus implements CourierBus {
  private handlers = new Set<(env: P2PEnvelope) => void | Promise<void>>();
  readonly sent: P2PEnvelope[] = [];
  private seq = 0;

  subscribe(_ns: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(env: P2PEnvelope): Promise<void> {
    this.sent.push(env);
  }

  /** 以 from 身分送一個封包給 server，回傳 server 對它的回覆。 */
  async inject(from: string, type: string, payload: unknown): Promise<P2PEnvelope | undefined> {
    const id = `req-${++this.seq}`;
    const env: P2PEnvelope = { v: 1, ns: COURIER_NS, type, id, ts: Date.now(), from, payload };
    for (const h of this.handlers) await h(env);
    return this.sent.find((e) => e.replyTo === id);
  }
}

async function setup() {
  const courier = await node();
  const bus = new RecordingBus();
  const server = new CourierServer(
    bus,
    new CourierStore(DEFAULT_COURIER_CONFIG),
    'courier-uid',
    undefined,
    undefined,
    new CourierIOUBook(courier.nodeId, courier.sign)
  );
  server.start();
  return { bus, server };
}

type QuoteAck = { accepted: boolean; quote?: { issuerNodeId: string }; reason?: string };

describe('CourierServer 通道範圍（Spec 029 Q5 現況）', () => {
  it('單一對端：IDENTIFY 後報價以該對端 nodeId 開出，回覆只寄給該對端', async () => {
    const { bus } = await setup();
    const a = await node();

    const idAck = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
    expect(idAck?.payload).toEqual({ ok: true });
    expect(idAck?.to).toBe('peer-A');

    const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
    expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
    expect(q?.to).toBe('peer-A');
  });

  it('未 IDENTIFY 的對端不能報價', async () => {
    const { bus } = await setup();
    const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
    expect(q?.payload).toEqual({ accepted: false, reason: 'identity-required' });
  });

  it('nodeId 與 pubKey 不符的 IDENTIFY 不採信，也不覆蓋既有身分', async () => {
    const { bus } = await setup();
    const [a, b] = await Promise.all([node(), node()]);
    await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });

    const bad = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: a.pubKey });
    expect(bad?.payload).toEqual({ ok: false });

    const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
    expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
  });

  describe('現況紀錄：實例不按 channelPeerId 隔離（發現，未修）', () => {
    it('同一實例收到兩個 from：後到的 IDENTIFY 覆蓋，A 的報價以 B 的 nodeId 開出', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);

      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      await bus.inject('peer-B', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: b.pubKey });

      const qa = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
      expect(qa?.to).toBe('peer-A');
      expect((qa?.payload as QuoteAck).quote?.issuerNodeId).toBe(b.nodeId);
    });

    it('未 IDENTIFY 的 from 可借用另一個 from 的身分取得報價', async () => {
      const { bus } = await setup();
      const a = await node();
      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });

      const qc = await bus.inject('peer-C', CourierMsgType.QUOTE, { bytes: 100 });
      expect((qc?.payload as QuoteAck).accepted).toBe(true);
      expect((qc?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
    });

    it('同一對端可再送 IDENTIFY 換成另一個合法身分', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);
      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      const second = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: b.pubKey });
      expect(second?.payload).toEqual({ ok: true });

      const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
      expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(b.nodeId);
    });
  });
});
