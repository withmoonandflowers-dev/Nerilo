/**
 * Spec 029 Q5 / C6：一個 CourierServer 實例的請求者狀態範圍。
 *
 * - 產品接線（web-vue useCourierNode.start）每個入站 relay 連線建一個 CourierServer，
 *   掛在該連線自己的 P2PChannelBus；relay channelId = 兩個 uid 排序相接，一條 DataChannel 只有一個對端。
 *   所以在產品路徑上，一個實例只服務一個 channelPeerId。
 * - 類別本身也要守住這件事（Spec 029 第 6 節第 2 點、C6）：第一個通過綁定驗證的 IDENTIFY
 *   連同它的 from 固定為 requester。相同 from、nodeId、pubKey 重送是冪等成功；
 *   換 nodeId、換 pubKey 或換 from 都拒絕（identify-ack ok:false），原身分保留。
 *   其他 from 視同未識別，拿不到報價也不能寄存。
 * - IDENTIFY 的驗證是非同步的，兩個幾乎同時到達時以到達順序為準，不看誰先驗完。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

/** 測試可對指定 nodeId 的綁定驗證設閘門，用來控制兩個 IDENTIFY 誰先驗完；沒設閘門就走真實驗證。 */
const bindGates = vi.hoisted(() => new Map<string, Promise<void>>());
vi.mock('../../src/core/relay/CourierReceipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/relay/CourierReceipts')>();
  return {
    ...actual,
    pubKeyBindsNodeId: async (nodeId: string, pubKey: string) => {
      const gate = bindGates.get(nodeId);
      if (!gate) return actual.pubKeyBindsNodeId(nodeId, pubKey);
      await gate;
      return true; // 設閘門的案例只用自洽身分；綁定本身由其他案例以真實驗證涵蓋
    },
  };
});

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

describe('CourierServer 通道範圍（Spec 029 Q5 / C6）', () => {
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

  describe('requester 固定後不可換人（Spec 029 C6）', () => {
    it('另一個 from 的 IDENTIFY 被拒絕，先到者的報價仍以自己的 nodeId 開出', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);

      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      const second = await bus.inject('peer-B', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: b.pubKey });
      expect(second?.payload).toEqual({ ok: false });

      const qa = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
      expect(qa?.to).toBe('peer-A');
      expect((qa?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);

      const qb = await bus.inject('peer-B', CourierMsgType.QUOTE, { bytes: 100 });
      expect(qb?.payload).toEqual({ accepted: false, reason: 'identity-required' });
    });

    it('另一個 from 拿已固定的 nodeId 與 pubKey 來 IDENTIFY 也被拒絕', async () => {
      const { bus } = await setup();
      const a = await node();
      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });

      const copy = await bus.inject('peer-C', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      expect(copy?.payload).toEqual({ ok: false });
      const qc = await bus.inject('peer-C', CourierMsgType.QUOTE, { bytes: 100 });
      expect(qc?.payload).toEqual({ accepted: false, reason: 'identity-required' });
    });

    it('未 IDENTIFY 的 from 不能借用另一個 from 的身分取得報價或寄存', async () => {
      const { bus } = await setup();
      const a = await node();
      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });

      const qc = await bus.inject('peer-C', CourierMsgType.QUOTE, { bytes: 100 });
      expect(qc?.payload).toEqual({ accepted: false, reason: 'identity-required' });

      const dc = await bus.inject('peer-C', CourierMsgType.DEPOSIT, {});
      expect(dc?.payload).toEqual({ accepted: false, reason: 'identity-required' });
      // 對照：已識別的 from 送同樣的空寄存，走到的是下一關（缺報價），不是身分關。
      const da = await bus.inject('peer-A', CourierMsgType.DEPOSIT, {});
      expect(da?.payload).toEqual({ accepted: false, reason: 'quote-required' });
    });

    it('同一對端換成另一個合法身分（nodeId 與 pubKey 都換）被拒絕，原身分保留', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);
      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      const second = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: b.pubKey });
      expect(second?.payload).toEqual({ ok: false });

      const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
      expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
    });

    it('同一對端只換 pubKey 或只換 nodeId 都被拒絕，原身分保留', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);
      await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });

      const otherKey = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: b.pubKey });
      expect(otherKey?.payload).toEqual({ ok: false });
      const otherNode = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: a.pubKey });
      expect(otherNode?.payload).toEqual({ ok: false });

      const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
      expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
    });

    it('相同 nodeId 與 pubKey 重送 IDENTIFY 維持成功（冪等）', async () => {
      const { bus } = await setup();
      const a = await node();
      const first = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      const again = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      expect(first?.payload).toEqual({ ok: true });
      expect(again?.payload).toEqual({ ok: true });

      const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
      expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
    });

    it('綁定驗證失敗的 IDENTIFY 不佔位，之後的合法 IDENTIFY 仍可成立', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);
      const bad = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: a.pubKey });
      expect(bad?.payload).toEqual({ ok: false });

      const good = await bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
      expect(good?.payload).toEqual({ ok: true });
    });

    it('兩個 IDENTIFY 幾乎同時到達：後到者先驗完，仍只有先到者成立', async () => {
      const { bus } = await setup();
      const [a, b] = await Promise.all([node(), node()]);
      let releaseA!: () => void;
      let releaseB!: () => void;
      bindGates.set(a.nodeId, new Promise<void>((r) => (releaseA = r)));
      bindGates.set(b.nodeId, new Promise<void>((r) => (releaseB = r)));
      try {
        // A 先到、B 後到，兩者的驗證都還沒回來。
        const pa = bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: a.nodeId, pubKey: a.pubKey });
        const pb = bus.inject('peer-A', CourierMsgType.IDENTIFY, { nodeId: b.nodeId, pubKey: b.pubKey });

        // 先放行 B 的驗證並讓出一輪事件迴圈：若實作以「誰先驗完」決定，B 會在這裡成立。
        // 閘門後的路徑只有 microtask，讓出一輪就足以跑完，結果不依賴機器快慢。
        releaseB();
        await new Promise<void>((r) => setTimeout(r, 0));
        releaseA();

        const [ackA, ackB] = await Promise.all([pa, pb]);
        expect(ackA?.payload).toEqual({ ok: true });
        expect(ackB?.payload).toEqual({ ok: false });

        const q = await bus.inject('peer-A', CourierMsgType.QUOTE, { bytes: 100 });
        expect((q?.payload as QuoteAck).quote?.issuerNodeId).toBe(a.nodeId);
      } finally {
        bindGates.clear();
      }
    });
  });
});
