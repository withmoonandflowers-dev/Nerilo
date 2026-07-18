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
  createDepositIOU,
  createContributionTransferDraft,
  createRepaymentRequest,
  type CourierIOUPersistence,
  type CourierIOUSnapshot,
  type CourierIOUBookConfig,
} from '../../src/core/incentive/CourierIOU';
import { createReceiptDraft, counterSign } from '../../src/core/incentive/CoSignedReceipt';
import { ecdsaSigner } from '../../src/core/relay/CourierReceipts';
import { senderIdFromPubKey } from '../../src/core/relay/TombstoneCrypto';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import { computeDigest, recordsPeerLacks } from '../../src/core/mesh/antiEntropy';
import type { GossipMessage, P2PEnvelope } from '../../src/types';
import { enc } from './_courierFixtures';

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
    content: enc('x'), ttl: 3, signature: 'SIG', ...over,
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

function iouPersistence(initial: CourierIOUSnapshot | null = null) {
  let snapshot = initial ? structuredClone(initial) : null;
  const persistence: CourierIOUPersistence = {
    async load() { return snapshot ? structuredClone(snapshot) : null; },
    async save(next) { snapshot = structuredClone(next); },
  };
  return { persistence, snapshot: () => snapshot ? structuredClone(snapshot) : null };
}

describe('Courier IOU — T3 報價、欠條與拒收', () => {
  it('同一調價週期內重複索取 QUOTE 不會操縱價格', async () => {
    const courier = await node();
    const requester = await node();
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000);
    const prices = Array.from({ length: 20 }, () => book.issueQuote(requester.nodeId, 10, 0).pricePerByteDay);
    expect(new Set(prices).size).toBe(1);
    expect(() => book.issueQuote(requester.nodeId, 0, 0)).toThrow(RangeError);
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
    expect(await client.repay(repayment)).toEqual({ accepted: false, reason: 'replayed-contribution' });
    expect(book.outstanding(debtor.nodeId)).toBe(0);
    expect(await client.deposit(rec({ seq: 2 }))).toMatchObject({ accepted: true });
  });

  it('缺原發票人轉讓同意或本人結清簽章時不註銷寄存欠條', async () => {
    const courier = await node();
    const debtor = await node();
    const beneficiary = await node();
    const record = rec();
    const bookConfig = config();
    const book = new CourierIOUBook(courier.nodeId, courier.sign, bookConfig, () => 1000);
    const quote = book.issueQuote(debtor.nodeId, recordBytes(record), 0);
    const depositIou = await createDepositIOU(quote, 1000, debtor.sign, 'deposit-nonce');
    expect(await book.acceptDepositIOU(depositIou, debtor.pubKey)).toMatchObject({ accepted: true });

    const receipt = await counterSign(
      await createReceiptDraft(debtor.nodeId, beneficiary.nodeId, 10_000, 900, 'service-negative', debtor.sign),
      beneficiary.sign,
    );
    const amount = Math.ceil(receipt.bytesRelayed * bookConfig.contributionPricePerByte * 1_000_000) / 1_000_000;
    const transfer = await createContributionTransferDraft(
      receipt, beneficiary.pubKey, debtor.pubKey, courier.nodeId, amount,
      beneficiary.sign, debtor.sign, 'transfer-negative',
    );
    const valid = await createRepaymentRequest(
      debtor.nodeId, debtor.pubKey, [depositIou.iouId], transfer, debtor.sign,
    );

    expect(await book.repay({ ...valid, settlementSig: 'forged' }))
      .toEqual({ accepted: false, reason: 'invalid-settlement' });
    expect(await book.repay({ ...valid, transfer: { ...transfer, issuerSig: 'forged' } }))
      .toEqual({ accepted: false, reason: 'invalid-transfer' });
    expect(book.outstanding(debtor.nodeId)).toBe(quote.amount);
  });

  it('store 拒收時回滾已接受的寄存欠條', async () => {
    const courier = await node();
    const debtor = await node();
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000);
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore({ ...DEFAULT_COURIER_CONFIG, totalBudgetBytes: 0 }, () => 1000);
    new CourierServer(courierBus, store, 'courier-uid', undefined, credit(courier), book).start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, member(debtor));
    client.start();

    expect(await client.deposit(rec())).toEqual({ accepted: false, reason: 'budget-zero' });
    expect(book.outstanding(debtor.nodeId)).toBe(0);
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

describe('Courier IOU — 債權簿持久化與重載復原', () => {
  it('重載後未結欠條與 epsilon 不歸零', async () => {
    const courier = await node();
    const issuer = await node();
    const durable = iouPersistence();
    const book1 = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000, durable.persistence, courier.pubKey);
    const quote1 = book1.issueQuote(issuer.nodeId, 100, 0);
    const iou1 = await createDepositIOU(quote1, 1000, issuer.sign, 'persist-1');
    expect(await book1.acceptDepositIOU(iou1, issuer.pubKey)).toMatchObject({ accepted: true });
    expect(await book1.flush()).toBe(true);

    const book2 = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 2000, durable.persistence, courier.pubKey);
    await book2.hydrate();
    expect(book2.outstanding(issuer.nodeId)).toBe(quote1.amount);

    const quote2 = book2.issueQuote(issuer.nodeId, 1000, 0);
    const iou2 = await createDepositIOU(quote2, 2000, issuer.sign, 'persist-2');
    expect(await book2.acceptDepositIOU(iou2, issuer.pubKey))
      .toEqual({ accepted: false, reason: 'insufficient-credit' });
  });

  it('hydrate 重驗簽章，損壞的持久欠條會被清除', async () => {
    const courier = await node();
    const issuer = await node();
    const durable = iouPersistence();
    const book1 = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000, durable.persistence, courier.pubKey);
    const quote = book1.issueQuote(issuer.nodeId, 100, 0);
    const iou = await createDepositIOU(quote, 1000, issuer.sign, 'valid-before-corruption');
    await book1.acceptDepositIOU(iou, issuer.pubKey);
    await book1.flush();
    const corrupted = durable.snapshot()!;
    corrupted.claims[0]!.iou.issuerSig = 'corrupted';
    const damaged = iouPersistence(corrupted);

    const restored = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 2000, damaged.persistence, courier.pubKey);
    await restored.hydrate();
    expect(restored.outstanding(issuer.nodeId)).toBe(0);
    expect(damaged.snapshot()?.claims).toEqual([]);
  });

  it('欠條快照寫入失敗時拒收並撤回已存紀錄', async () => {
    const courier = await node();
    const issuer = await node();
    const failing: CourierIOUPersistence = {
      async load() { return null; },
      async save() { throw new Error('disk full'); },
    };
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config(), () => 1000, failing, courier.pubKey);
    const [memberBus, courierBus] = linkedBuses();
    const store = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, store, 'courier-uid', undefined, credit(courier), book).start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, member(issuer));
    client.start();

    expect(await client.deposit(rec())).toEqual({ accepted: false, reason: 'persistence-failed' });
    expect(store.stats().recordCount).toBe(0);
    expect(book.outstanding(issuer.nodeId)).toBe(0);
  });

  it('已接受服務欠條的防重放狀態跨重載保留', async () => {
    const courier = await node();
    const debtor = await node();
    const beneficiary = await node();
    const durable = iouPersistence();
    const cfg = config();
    const book1 = new CourierIOUBook(courier.nodeId, courier.sign, cfg, () => 1000, durable.persistence, courier.pubKey);
    const quote = book1.issueQuote(debtor.nodeId, 100, 0);
    const deposit = await createDepositIOU(quote, 1000, debtor.sign, 'deposit-replay');
    await book1.acceptDepositIOU(deposit, debtor.pubKey);
    const bytes = Math.round(quote.amount / cfg.contributionPricePerByte);
    const receipt = await counterSign(
      await createReceiptDraft(debtor.nodeId, beneficiary.nodeId, bytes, 900, 'durable-service', debtor.sign),
      beneficiary.sign,
    );
    const amount = Math.ceil(bytes * cfg.contributionPricePerByte * 1_000_000) / 1_000_000;
    const transfer = await createContributionTransferDraft(
      receipt, beneficiary.pubKey, debtor.pubKey, courier.nodeId, amount,
      beneficiary.sign, debtor.sign, 'durable-transfer',
    );
    const repayment = await createRepaymentRequest(
      debtor.nodeId, debtor.pubKey, [deposit.iouId], transfer, debtor.sign,
    );
    expect(await book1.repay(repayment)).toMatchObject({ accepted: true });

    const book2 = new CourierIOUBook(courier.nodeId, courier.sign, cfg, () => 2000, durable.persistence, courier.pubKey);
    await book2.hydrate();
    expect(await book2.repay(repayment)).toEqual({ accepted: false, reason: 'replayed-contribution' });
  });
});

describe('Courier IOU — V4 免費成員互補不受信使拒收影響', () => {
  it('所有信使拒收時保留本地權威紀錄，成員 anti-entropy 仍最終補齊', async () => {
    const courier = await node();
    const sender = await node();
    const localRecord = rec({ roomId: 'free-baseline', senderId: sender.nodeId, seq: 1 });
    const peerRecord = rec({ roomId: 'free-baseline', senderId: 'peer-signer', seq: 1, content: enc('peer') });
    const book = new CourierIOUBook(courier.nodeId, courier.sign, config({ creditLimitPerIssuer: 0 }), () => 1000);
    const [memberBus, courierBus] = linkedBuses();
    const courierStore = new CourierStore(DEFAULT_COURIER_CONFIG, () => 1000);
    new CourierServer(courierBus, courierStore, 'courier-uid', undefined, credit(courier), book).start();
    const client = new CourierClient(memberBus, 'member-uid', 3000, member(sender));
    client.start();

    // 信使路徑是可拒絕的加速層；拒收不能取得或刪除成員的本地權威紀錄。
    const memberA = new Map([[localRecord.senderId, new Map([[localRecord.seq, localRecord]])]]);
    const memberB = new Map([[peerRecord.senderId, new Map([[peerRecord.seq, peerRecord]])]]);
    expect(await client.deposit(localRecord)).toEqual({ accepted: false, reason: 'insufficient-credit' });
    expect(courierStore.stats().recordCount).toBe(0);
    expect(memberA.get(localRecord.senderId)?.get(localRecord.seq)).toBe(localRecord);

    // 免費底線：兩個房間成員用同一套正式 digest/select 原語互補，無欠條亦可收斂。
    const digestA = computeDigest(memberA, new Map());
    const digestB = computeDigest(memberB, new Map());
    for (const message of recordsPeerLacks(memberA, digestB)) {
      if (!memberB.has(message.senderId)) memberB.set(message.senderId, new Map());
      memberB.get(message.senderId)!.set(message.seq, message);
    }
    for (const message of recordsPeerLacks(memberB, digestA)) {
      if (!memberA.has(message.senderId)) memberA.set(message.senderId, new Map());
      memberA.get(message.senderId)!.set(message.seq, message);
    }

    expect(memberA.get(peerRecord.senderId)?.get(peerRecord.seq)).toBe(peerRecord);
    expect(memberB.get(localRecord.senderId)?.get(localRecord.seq)).toBe(localRecord);
  });
});
