/**
 * Spec 001 T3–T5：有對象欠條、報價/額度拒收、交換結清與垃圾寄存攻擊。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { CourierStore, DEFAULT_COURIER_CONFIG, recordBytes } from '../../src/core/relay/CourierStore';
import {
  CourierClient,
  CourierServer,
  type CourierBus,
  type CourierCreditConfig,
  type MemberCreditConfig,
} from '../../src/core/relay/CourierService';
import {
  CourierIOUBook,
  createContributionTransferDraft,
  createRepaymentRequest,
  type CourierIOUBookConfig,
} from '../../src/core/incentive/CourierIOU';
import { createReceiptDraft, counterSign } from '../../src/core/incentive/CoSignedReceipt';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage, P2PEnvelope } from '../../src/types';

class BusEnd implements CourierBus {
  private handlers = new Map<string, Set<(env: P2PEnvelope) => void | Promise<void>>>();
  partner!: BusEnd;

  subscribe(ns: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void {
    if (!this.handlers.has(ns)) this.handlers.set(ns, new Set());
    this.handlers.get(ns)!.add(handler);
    return () => this.handlers.get(ns)?.delete(handler);
  }

  async send(env: P2PEnvelope): Promise<void> {
    await Promise.resolve();
    for (const handler of this.partner.handlers.get(env.ns) ?? []) await handler(env);
  }
}

function linkedBuses(): [BusEnd, BusEnd] {
  const a = new BusEnd();
  const b = new BusEnd();
  a.partner = b;
  b.partner = a;
  return [a, b];
}

async function node() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubKey = arrayBufferToBase64(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { nodeId: await senderIdFromPubKey(pubKey), pubKey, sign: ecdsaSigner(kp.privateKey) };
}

function rec(over: Partial<GossipMessage> = {}): GossipMessage {
  return {
    roomId: 'room', senderId: 'record-signer', pubKey: 'pk', seq: 1, timestamp: 1,
    content: 'ENC:x', ttl: 3, signature: 'SIG', ...over,
  };
}

function config(over: Partial<CourierIOUBookConfig> = {}): CourierIOUBookConfig {
  return {
    creditLimitPerIssuer: 1,
    quoteTtlMs: 30_000,
    pricingIntervalMs: 60_000,
    storageDurationMs: 86_400_000,
    initialStoragePrice: 0.001,
    contributionPricePerByte: 0.000_001,
    pricing: { targetUtilization: 0.5, adjustmentRate: 0.1, minPrice: 0.000_001, maxPrice: 1 },
    ...over,
  };
}

function credit(n: Awaited<ReturnType<typeof node>>): CourierCreditConfig {
  return { nodeId: n.nodeId, pubKey: n.pubKey, sign: n.sign, onCredit: () => {} };
}

function member(n: Awaited<ReturnType<typeof node>>): MemberCreditConfig {
  return { nodeId: n.nodeId, pubKey: n.pubKey, sign: n.sign };
}

describe('Courier IOU — T3 報價、欠條與拒收', () => {
  it('同一調價週期內重複索取 QUOTE 不會操縱價格', async () => {
    const courier = await node();
    const requester = await node();
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000);
    const prices = Array.from({ length: 20 }, () => book.issueQuote(requester.nodeId, 10, 0).pricePerByteDay);
    expect(new Set(prices).size).toBe(1);
  });

  it('寄存自動取得報價並開具本人欠條；超過該信使授信 epsilon 後拒收', async () => {
    const courier = await node();
    const requester = await node();
    const first = rec({ seq: 1 });
    const firstCost = recordBytes(first) * 0.00095; // u=0：0.001 * [1 + .1*(0-.5)]
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config({
      creditLimitPerIssuer: firstCost + 0.000_001,
    }), () => 1000);
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier-uid', undefined, credit(courier), book).start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, member(requester));
    client.start();

    expect(await client.deposit(first)).toMatchObject({ accepted: true });
    expect(book.outstanding(requester.nodeId)).toBeCloseTo(firstCost);
    expect(await client.deposit(rec({ seq: 2 }))).toEqual({ accepted: false, reason: 'insufficient-credit' });
    expect(store.stats().recordCount).toBe(1);
  });

  it('欠條簽章被竄改時不存資料', async () => {
    const courier = await node();
    const requester = await node();
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000);
    const quote = book.issueQuote(requester.nodeId, 10, 0);
    // 不走 client：用錯誤簽章證明 book 本身 fail-closed。
    const bad = {
      iouId: 'x', quoteId: quote.quoteId, issuerNodeId: requester.nodeId,
      holderNodeId: courier.nodeId, amount: quote.amount, issuedAt: 1000,
      nonce: 'n', issuerSig: 'forged',
    };
    expect(await book.acceptDepositIOU(bad, requester.pubKey)).toEqual({ accepted: false, reason: 'invalid-iou' });
  });
});

describe('Courier IOU — T4 貢獻欠條交換後恢復額度', () => {
  it('原發票人＋持有人同意轉讓，且本人簽結清後，才能再寄存', async () => {
    const courier = await node(); // C：提供寄存、持有 B 的寄存欠條
    const debtor = await node();  // B：寄存者，也是另一筆服務的貢獻者
    const beneficiary = await node(); // A：受益人，向 B 開服務欠條
    const record = rec({ seq: 1 });
    const debtAmount = recordBytes(record) * 0.00095;
    const bookConfig = config({
      creditLimitPerIssuer: debtAmount + 0.000_001,
      contributionPricePerByte: 0.000_001,
    });
    const book = new CourierIOUBook(courier.nodeId, courier.sign, bookConfig, () => 1000);
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier-uid', undefined, credit(courier), book).start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, member(debtor));
    client.start();

    expect(await client.deposit(record)).toMatchObject({ accepted: true });
    expect(await client.deposit(rec({ seq: 2 }))).toMatchObject({ accepted: false, reason: 'insufficient-credit' });

    // B 曾替 A 提供服務：B 先簽服務收據，A 回簽，形成「A 欠 B」的有對象欠條。
    const contributionBytes = Math.round(debtAmount / bookConfig.contributionPricePerByte);
    const draft = await createReceiptDraft(
      debtor.nodeId, beneficiary.nodeId, contributionBytes, 900, 'service-iou', debtor.sign
    );
    const receipt = await counterSign(draft, beneficiary.sign);
    // A 同意欠條從 B 轉給 C；B 同意交付；C 的接受簽章由 book.repay 最後產生。
    const transfer = await createContributionTransferDraft(
      receipt, beneficiary.pubKey, debtor.pubKey, courier.nodeId, debtAmount,
      beneficiary.sign, debtor.sign, 'transfer-1'
    );
    // C 把 B 自己的寄存欠條退回 B；只有 B 本人簽 settlement 才能註銷。
    const repayment = await createRepaymentRequest(
      debtor.nodeId, debtor.pubKey, book.activeClaimIds(debtor.nodeId), transfer, debtor.sign
    );
    expect(await client.repay(repayment)).toMatchObject({ accepted: true, settledAmount: debtAmount });
    expect(book.outstanding(debtor.nodeId)).toBe(0);
    expect(await client.deposit(rec({ seq: 2 }))).toMatchObject({ accepted: true });
  });
});

describe('Courier IOU — T5 垃圾寄存攻擊模擬', () => {
  it('單一攻擊身分耗盡授信後持續寄存皆被拒，誠實房不被擠出', async () => {
    const courier = await node();
    const honest = await node();
    const attacker = await node();
    const honestRecord = rec({ roomId: 'honest', senderId: honest.nodeId, seq: 1 });
    const attackRecord = rec({ roomId: 'junk-1', senderId: attacker.nodeId, seq: 1 });
    const maxBytes = Math.max(recordBytes(honestRecord), recordBytes(attackRecord));
    const firstCost = maxBytes * 0.00095;
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config({
      creditLimitPerIssuer: firstCost + 0.000_001,
    }), () => 1000);
    const store = new CourierStore({
      ...DEFAULT_COURIER_CONFIG,
      maxRoomBytes: maxBytes * 2,
      totalBudgetBytes: maxBytes * 2,
    }, () => 1000);

    async function connect(n: Awaited<ReturnType<typeof node>>, uid: string) {
      const [memberBus, courierBus] = linkedBuses();
      new CourierServer(courierBus, store, `courier-${uid}`, undefined, credit(courier), book).start();
      const client = new CourierClient(memberBus, uid, 3000, member(n));
      client.start();
      return client;
    }
    const honestClient = await connect(honest, 'honest-uid');
    const attackClient = await connect(attacker, 'attack-uid');

    expect(await honestClient.deposit(honestRecord)).toMatchObject({ accepted: true });
    expect(await attackClient.deposit(attackRecord)).toMatchObject({ accepted: true });
    let rejected = 0;
    for (let i = 2; i <= 20; i++) {
      const result = await attackClient.deposit(rec({
        roomId: `junk-${i}`, senderId: attacker.nodeId, seq: i,
      }));
      if (!result.accepted && result.reason === 'insufficient-credit') rejected += 1;
    }
    expect(rejected).toBe(19);
    expect(store.serveRoom('honest')).toHaveLength(1);
    expect(store.stats().recordCount).toBe(2);
  });
});
