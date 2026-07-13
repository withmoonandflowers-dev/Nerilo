/**
 * CourierService — 盲信使寄存協議，跑在 P2PChannelBus 上（ADR-0023 P4-C.2 / ADR-0024）
 *
 * P4-B 給了「陌生節點 ↔ 成員」的 relay DataChannel；本模組定義在那條通道上流動的內容：
 * 成員把密文紀錄寄存給信使、離線期由信使代管、成員回線把紀錄拉回。與遊戲/聊天同樣
 * 掛在 P2PChannelBus 的 namespace 分派上（ns='courier'），不新開傳輸。
 *
 * 兩個角色（同一協議兩端）：
 *   - CourierServer（信使方）：收 deposit→存進 CourierStore；收 pull→吐該房密文；
 *     收 tombstone→驗章即刪。回覆用 replyTo 關聯。
 *   - CourierClient（成員方）：deposit(record) 寄存、pull(roomId) 取回、tombstone(roomId) 撤存。
 *     pull 走 request/response（correlationId + 逾時）。
 *
 * 盲性：CourierServer 只碰密文信封與簽章，不持金鑰、不解內容（見 CourierStore）。
 * 傳輸無關：只依賴極小的 CourierBus 介面（subscribe/send），可用 P2PChannelBus，
 * 也可用測試用的記憶體對接 bus → 寄存/取回可在無 WebRTC 下完整驗證。
 */

import type { P2PEnvelope, GossipMessage } from '../../types';
import { CourierStore, type DepositResult } from './CourierStore';
import { computeDigest, normalizeDigest, peerLacks, type GossipDigest } from '../mesh/antiEntropy';
import { verifyTombstone, type Tombstone } from './TombstoneCrypto';
import { ecdsaVerifier, pubKeyBindsNodeId, verifyCoSignedReceipt } from './CourierReceipts';
import {
  createReceiptDraft,
  counterSign,
  verifyDraft,
  type ReceiptDraft,
  type CoSignedRelayReceipt,
  type SignFn,
} from '../incentive/CoSignedReceipt';
import { generateUUID } from '../../utils/uuid';
import { logger } from '../../utils/logger';

export const COURIER_NS = 'courier';

export const CourierMsgType = {
  DEPOSIT: 'deposit',
  DEPOSIT_ACK: 'deposit-ack',
  PULL: 'pull',
  RECORDS: 'records',
  TOMBSTONE: 'tombstone',
  TOMBSTONE_ACK: 'tombstone-ack',
  /** anti-entropy 對帳：成員送 digest，信使回「成員缺的紀錄 + 信使自己的 digest」。 */
  SYNC: 'sync',
  SYNC_RESP: 'sync-resp',
  /** 計量（ADR-0022）：成員自報身分；信使起草收據；成員回簽。 */
  IDENTIFY: 'identify',
  IDENTIFY_ACK: 'identify-ack',
  RECEIPT_DRAFT: 'receipt-draft',
  RECEIPT_SIGNED: 'receipt-signed',
} as const;

/** 成員自報 mesh 身分（供信使起草可驗收據）。 */
interface IdentifyPayload {
  nodeId: string;
  pubKey: string;
}
/** 信使→成員：起草收據 + 信使公鑰（成員據此驗 relay 半簽）。 */
interface ReceiptDraftPayload {
  draft: ReceiptDraft;
  relayPubKey: string;
}
/** 成員→信使：共簽收據 + 成員公鑰（信使據此驗 requester 半簽 + 綁定 nodeId）。 */
interface ReceiptSignedPayload {
  receipt: CoSignedRelayReceipt;
  requesterPubKey: string;
}

/** 信使方計量設定（注入身分金鑰與計點落點）。省略 = 不計量（純代管）。 */
export interface CourierCreditConfig {
  nodeId: string;
  pubKey: string;
  sign: SignFn;
  /** 收到可驗共簽收據後的計點落點（例：CreditEconomy.recordRelayContribution）。 */
  onCredit: (requesterNodeId: string, bytes: number) => void | Promise<void>;
}

/** 成員方計量設定（注入身分金鑰）。省略 = 不回簽（不參與計量）。 */
export interface MemberCreditConfig {
  nodeId: string;
  pubKey: string;
  sign: SignFn;
  /** 起草收據的合理性檢查（bytes 是否 ≤ 我實際寄存過的）。省略 = 一律回簽。 */
  approve?: (draft: ReceiptDraft) => boolean;
}

/** CourierService 需要的最小傳輸能力（P2PChannelBus 即滿足）。 */
export interface CourierBus {
  subscribe(namespace: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void;
  send(envelope: P2PEnvelope): Promise<void>;
}

interface PullPayload {
  roomId: string;
}
interface RecordsPayload {
  roomId: string;
  records: GossipMessage[];
}
interface TombstonePayload {
  roomId: string;
  /** 成員以房籍身分簽的墓碑證明（pubKey + 房籍 + 簽章）；驗證由 server 注入。 */
  proof: unknown;
}
interface SyncPayload {
  roomId: string;
  /** 成員對該房的 anti-entropy digest（每 sender 的 floor/max/missing）。 */
  digest: GossipDigest;
}
interface SyncRespPayload {
  roomId: string;
  /** 信使有、成員缺的紀錄（補離線間隙）。 */
  records: GossipMessage[];
  /** 信使自己對該房的 digest，讓成員回推信使缺的紀錄（雙向對帳）。 */
  digest: GossipDigest;
}

/** 由紀錄陣列建 anti-entropy store 視圖：Map<senderId, Map<seq, GossipMessage>>。 */
export function buildRoomStore(records: GossipMessage[]): Map<string, Map<number, GossipMessage>> {
  const store = new Map<string, Map<number, GossipMessage>>();
  for (const m of records) {
    let inner = store.get(m.senderId);
    if (!inner) {
      inner = new Map<number, GossipMessage>();
      store.set(m.senderId, inner);
    }
    if (!inner.has(m.seq)) inner.set(m.seq, m); // first-write-wins（對齊 CourierStore）
  }
  return store;
}

/** digest 對照下，store 中「對方缺」的紀錄。供雙向 push 用。 */
function recordsPeerLacks(
  store: ReadonlyMap<string, ReadonlyMap<number, GossipMessage>>,
  peerDigestRaw: GossipDigest
): GossipMessage[] {
  const norm = normalizeDigest(peerDigestRaw);
  if (!norm) return [];
  const out: GossipMessage[] = [];
  for (const [senderId, seqs] of store) {
    for (const [seq, msg] of seqs) {
      if (peerLacks(norm, senderId, seq)) out.push(msg);
    }
  }
  return out;
}

function envelope(type: string, from: string, payload: unknown, over: Partial<P2PEnvelope> = {}): P2PEnvelope {
  return {
    v: 1,
    ns: COURIER_NS,
    type,
    id: generateUUID(),
    ts: Date.now(),
    from,
    payload,
    ...over,
  };
}

/**
 * 信使方：把 CourierStore 掛到 bus 的 courier namespace。
 * 墓碑驗證：預設用 TombstoneCrypto 對「該房 store 裡的 senderId 集合」做盲驗（簽章 + 房籍）。
 * 可注入 verifyOverride 供測試/替代策略。
 */
export class CourierServer {
  private unsub: (() => void) | null = null;
  /** 計量狀態：連上的成員身分、尚未計點的代管位元組、在途收據（nonce→bytes）。 */
  private requester: IdentifyPayload | null = null;
  private bytesOwed = 0;
  private inFlight: { nonce: string; bytes: number } | null = null;

  constructor(
    private readonly bus: CourierBus,
    private readonly store: CourierStore,
    private readonly selfId: string,
    private readonly verifyOverride?: (roomId: string, proof: unknown) => boolean | Promise<boolean>,
    private readonly credit?: CourierCreditConfig
  ) {}

  /** 房籍簽章墓碑驗證：注入者優先，否則預設用 store 的 senderId 集合做盲驗。 */
  private verifyTombstone(roomId: string, proof: unknown): boolean | Promise<boolean> {
    if (this.verifyOverride) return this.verifyOverride(roomId, proof);
    const roomSenderIds = new Set(this.store.roomStore(roomId).keys());
    return verifyTombstone(proof as Tombstone, roomSenderIds);
  }

  start(): void {
    if (this.unsub) return;
    this.unsub = this.bus.subscribe(COURIER_NS, (env) => this.onEnvelope(env));
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /**
   * 起草收據向已識別的成員請求回簽（計量一輪）。需：已設 credit config、已收成員 IDENTIFY、
   * 有未計量位元組、無在途收據。起草由信使簽 → 送 RECEIPT_DRAFT；回簽在 onReceiptSigned 收。
   */
  async claimCredit(): Promise<void> {
    if (!this.credit || !this.requester || this.bytesOwed <= 0 || this.inFlight) return;
    const bytes = this.bytesOwed;
    const nonce = generateUUID();
    let draft: ReceiptDraft;
    try {
      draft = await createReceiptDraft(
        this.credit.nodeId,
        this.requester.nodeId,
        bytes,
        Date.now(),
        nonce,
        this.credit.sign
      );
    } catch (err) {
      logger.warn('[CourierServer] createReceiptDraft failed', { err });
      return;
    }
    this.inFlight = { nonce, bytes };
    this.bytesOwed -= bytes; // 移出待計；成員拒簽/逾時則作廢（best-effort，不回補）
    await this.bus.send(
      envelope(CourierMsgType.RECEIPT_DRAFT, this.selfId, {
        draft,
        relayPubKey: this.credit.pubKey,
      } as ReceiptDraftPayload)
    );
  }

  /** 收成員回簽：驗三關（雙 pubKey 綁定 + 雙簽有效）通過才計點。 */
  private async onReceiptSigned(payload: ReceiptSignedPayload): Promise<void> {
    if (!this.credit || !this.inFlight) return;
    const { receipt, requesterPubKey } = payload;
    if (receipt.nonce !== this.inFlight.nonce || receipt.bytesRelayed !== this.inFlight.bytes) return;
    const ok = await verifyCoSignedReceipt(receipt, this.credit.pubKey, requesterPubKey);
    if (ok) {
      await this.credit.onCredit(receipt.requesterNodeId, receipt.bytesRelayed);
    } else {
      logger.warn('[CourierServer] co-signed receipt failed verification');
    }
    this.inFlight = null;
  }

  private async onEnvelope(env: P2PEnvelope): Promise<void> {
    if (env.from === this.selfId) return; // 不處理自己送的（bus 可能回放）
    try {
      switch (env.type) {
        case CourierMsgType.DEPOSIT: {
          const rec = env.payload as GossipMessage;
          const result = this.store.deposit(rec);
          if (result.accepted) this.bytesOwed += result.bytes; // 累計可計量代管
          await this.reply(env, CourierMsgType.DEPOSIT_ACK, result);
          break;
        }
        case CourierMsgType.IDENTIFY: {
          const { nodeId, pubKey } = env.payload as IdentifyPayload;
          // 綁定：nodeId 必須是該 pubKey 導出的，否則冒名 → 不採信。
          const ok = await pubKeyBindsNodeId(nodeId, pubKey);
          if (ok) this.requester = { nodeId, pubKey };
          await this.reply(env, CourierMsgType.IDENTIFY_ACK, { ok }); // 讓成員確知已收（可靠遞送）
          break;
        }
        case CourierMsgType.RECEIPT_SIGNED: {
          await this.onReceiptSigned(env.payload as ReceiptSignedPayload);
          break;
        }
        case CourierMsgType.PULL: {
          const { roomId } = env.payload as PullPayload;
          const records = this.store.serveRoom(roomId);
          await this.reply(env, CourierMsgType.RECORDS, { roomId, records } as RecordsPayload);
          break;
        }
        case CourierMsgType.TOMBSTONE: {
          const { roomId, proof } = env.payload as TombstonePayload;
          const freed = await this.store.applyTombstone(roomId, () =>
            this.verifyTombstone(roomId, proof)
          );
          await this.reply(env, CourierMsgType.TOMBSTONE_ACK, { roomId, freed });
          break;
        }
        case CourierMsgType.SYNC: {
          const { roomId, digest } = env.payload as SyncPayload;
          const roomStore = this.store.roomStore(roomId); // 標記房被存取（LRU 保鮮）由 serveRoom 做；此處只讀
          // 信使有、成員缺 → 補送（離線間隙回填）。
          const records = recordsPeerLacks(roomStore, digest);
          // 信使自己的 digest（floors 空 = floor 1；信使 TTL 內不遺忘）→ 讓成員回推信使缺的。
          const courierDigest = computeDigest(roomStore, new Map());
          await this.reply(env, CourierMsgType.SYNC_RESP, {
            roomId,
            records,
            digest: courierDigest,
          } as SyncRespPayload);
          break;
        }
        default:
          break; // 未知 type 忽略（向前相容）
      }
    } catch (err) {
      logger.warn('[CourierServer] onEnvelope error', { type: env.type, err });
    }
  }

  private reply(orig: P2PEnvelope, type: string, payload: unknown): Promise<void> {
    return this.bus.send(envelope(type, this.selfId, payload, { to: orig.from, replyTo: orig.id }));
  }
}

/** pull/tombstone 的 request/response 逾時（ms）。 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 成員方：對某個信使寄存/取回。deposit 為 fire-and-forget（收 ack 但不阻塞 liveness；
 * anti-entropy 之後照樣對帳）；pull/tombstone 走 request/response 關聯。
 */
export class CourierClient {
  private readonly pending = new Map<string, (env: P2PEnvelope) => void>();
  private unsub: (() => void) | null = null;

  constructor(
    private readonly bus: CourierBus,
    private readonly selfId: string,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
    private readonly credit?: MemberCreditConfig
  ) {}

  start(): void {
    if (this.unsub) return;
    this.unsub = this.bus.subscribe(COURIER_NS, (env) => {
      // 計量：信使起草收據 → 驗 + 回簽（不是 replyTo 關聯，是信使主動推）。
      if (env.type === CourierMsgType.RECEIPT_DRAFT && env.from !== this.selfId) {
        void this.onReceiptDraft(env.payload as ReceiptDraftPayload);
        return;
      }
      if (env.replyTo && this.pending.has(env.replyTo)) {
        this.pending.get(env.replyTo)!(env);
      }
    });
    // 自報身分（可靠遞送：等 IDENTIFY_ACK，重試跨越「信使伺服器尚未掛上」視窗）。
    if (this.credit) void this.identifyWithRetry();
  }

  /** 送 IDENTIFY 並等 ack，重試到成功（信使 CourierServer 晚訂閱時 inbound 不緩衝晚訂閱者）。 */
  private async identifyWithRetry(attempts = 5): Promise<void> {
    if (!this.credit) return;
    const payload: IdentifyPayload = { nodeId: this.credit.nodeId, pubKey: this.credit.pubKey };
    for (let i = 0; i < attempts; i++) {
      try {
        await this.request(envelope(CourierMsgType.IDENTIFY, this.selfId, payload));
        return;
      } catch {
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** 收信使起草：驗 relay 半簽 + pubKey 綁定 + 收據是給我的 + 合理性 → 回簽。 */
  private async onReceiptDraft(payload: ReceiptDraftPayload): Promise<void> {
    if (!this.credit) return;
    const { draft, relayPubKey } = payload;
    try {
      if (draft.requesterNodeId !== this.credit.nodeId) return; // 不是給我的
      if (!(await pubKeyBindsNodeId(draft.relayNodeId, relayPubKey))) return; // relay 冒名
      const relayVerify = await ecdsaVerifier(relayPubKey);
      if (!(await verifyDraft(draft, relayVerify))) return; // relay 半簽無效
      if (this.credit.approve && !this.credit.approve(draft)) return; // bytes 不合理 → 不簽
      const receipt = await counterSign(draft, this.credit.sign);
      await this.bus.send(
        envelope(CourierMsgType.RECEIPT_SIGNED, this.selfId, {
          receipt,
          requesterPubKey: this.credit.pubKey,
        } as ReceiptSignedPayload)
      );
    } catch (err) {
      logger.warn('[CourierClient] onReceiptDraft failed', { err });
    }
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.pending.clear();
  }

  /** 寄存一筆密文紀錄；回傳信使的 DepositResult（accepted / 拒收原因）。 */
  async deposit(record: GossipMessage): Promise<DepositResult> {
    const req = envelope(CourierMsgType.DEPOSIT, this.selfId, record);
    const ack = await this.request(req);
    return ack.payload as DepositResult;
  }

  /** 回線取回某房的全部代管密文紀錄。 */
  async pull(roomId: string): Promise<GossipMessage[]> {
    const req = envelope(CourierMsgType.PULL, this.selfId, { roomId } as PullPayload);
    const resp = await this.request(req);
    return (resp.payload as RecordsPayload).records ?? [];
  }

  /** 撤存：送房籍簽名墓碑，信使驗章即刪。回傳釋放位元組（0=驗證未過）。 */
  async tombstone(roomId: string, proof: unknown): Promise<number> {
    const req = envelope(CourierMsgType.TOMBSTONE, this.selfId, { roomId, proof } as TombstonePayload);
    const resp = await this.request(req);
    return (resp.payload as { freed: number }).freed ?? 0;
  }

  /**
   * 與信使做一輪 anti-entropy 對帳（雙向）：
   *  1. 送本地 digest → 收信使有、我缺的紀錄 → ingest（補離線間隙）。
   *  2. 依信使回傳的 digest，把信使缺的本地紀錄 push 回去（deposit，first-write-wins）。
   * 一輪即收斂（對稱差嚴格縮小；見 antiEntropy 收斂論證）。
   * @param localStore 本地該房 store（Map<senderId, Map<seq, msg>>；可用 buildRoomStore 從陣列造）。
   * @param floors 本地各 sender 的 floor（已淘汰下限）；無則傳空 Map（floor 預設 1）。
   * @param ingest 收到「我缺的紀錄」時的回填（呼叫端寫入自己的 store/UI）。
   * @returns { received: 收到補的筆數, pushed: 回推信使的筆數 }
   */
  async reconcile(
    roomId: string,
    localStore: ReadonlyMap<string, ReadonlyMap<number, GossipMessage>>,
    floors: ReadonlyMap<string, number>,
    ingest: (msg: GossipMessage) => void
  ): Promise<{ received: number; pushed: number }> {
    const myDigest = computeDigest(localStore, floors);
    const req = envelope(CourierMsgType.SYNC, this.selfId, { roomId, digest: myDigest } as SyncPayload);
    const resp = await this.request(req);
    const { records, digest: courierDigest } = resp.payload as SyncRespPayload;

    for (const m of records ?? []) ingest(m); // 方向一：信使補我

    // 方向二：我回推信使缺的（用信使 digest 過濾本地）。
    const toPush = recordsPeerLacks(localStore, courierDigest ?? {});
    for (const m of toPush) await this.deposit(m); // 逐筆 deposit（已測、ack 冪等）
    return { received: (records ?? []).length, pushed: toPush.length };
  }

  /** 送出 req，等 replyTo==req.id 的回覆；逾時即 reject。 */
  private request(req: P2PEnvelope): Promise<P2PEnvelope> {
    return new Promise<P2PEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`[CourierClient] request timeout: ${req.type}`));
      }, this.timeoutMs);
      this.pending.set(req.id, (env) => {
        clearTimeout(timer);
        this.pending.delete(req.id);
        resolve(env);
      });
      this.bus.send(req).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}

/** 成員背景備份一輪需要的注入依賴（純邏輯，可測；composable 提供真實作）。 */
export interface CourierBackupDeps {
  /** 我持有紀錄的房 id（getGossipReplicaStore().listRooms）。 */
  listRooms: () => Promise<string[]>;
  /** 載入一房的持久紀錄 + floors。 */
  loadRoom: (
    roomId: string
  ) => Promise<{ records: GossipMessage[]; floors: Array<{ senderId: string; floor: number }> }>;
  /** 把信使補回來的紀錄寫進本地持久層（離線間隙落地）。 */
  saveRecord: (roomId: string, msg: GossipMessage) => Promise<void>;
  /**
   * 發現候選信使（非自己）的 firebase uid，新鮮者優先。回多個以容忍陳舊名冊條目：
   * 節點崩潰未撤回時仍留在名冊，連上去 DataChannel 永不開、對帳逾時 → 換下一個候選。
   */
  discoverCourierUids: () => Promise<string[]>;
  /** 對該信使開一條 courier client（連上 + 取 bus + start）；失敗回 null。 */
  openClient: (courierUid: string) => Promise<CourierClient | null>;
}

/**
 * 成員背景備份一輪（app 觸發整合，ADR-0023 P4-C）：
 * 發現候選信使 → 逐一嘗試直到「可達」的一個 → 對「我持有紀錄的每一房」做一輪 reconcile
 * （推我有信使缺的、收信使有我缺的並落地）。全程 best-effort，任一步失敗只影響本次備份，不拋。
 * reconcile 為 digest-based，穩態下重跑幾乎零傳輸（只送 digest）。
 */
export async function runCourierBackup(
  deps: CourierBackupDeps
): Promise<{ rooms: number; received: number; pushed: number }> {
  const summary = { rooms: 0, received: 0, pushed: 0 };

  let roomIds: string[] = [];
  try {
    roomIds = await deps.listRooms();
  } catch (err) {
    logger.warn('[runCourierBackup] listRooms failed', { err });
    return summary;
  }
  if (roomIds.length === 0) return summary; // 沒資料要備份 → 不連任何信使

  let candidates: string[] = [];
  try {
    candidates = await deps.discoverCourierUids();
  } catch (err) {
    logger.warn('[runCourierBackup] discover failed', { err });
  }

  for (const courierUid of candidates) {
    // openClient 只在連線真的到 'connected'（DataChannel 開）才回 client；陳舊/不可達
    // 候選永遠到不了 connected → 回 null → 換下一個。故到這裡即代表信使可達。
    let client: CourierClient | null = null;
    try {
      client = await deps.openClient(courierUid);
    } catch (err) {
      logger.warn('[runCourierBackup] openClient failed', { courierUid, err });
    }
    if (!client) continue;

    for (const roomId of roomIds) {
      try {
        const { records, floors } = await deps.loadRoom(roomId);
        const localStore = buildRoomStore(records);
        const floorMap = new Map(floors.map((f) => [f.senderId, f.floor] as const));
        // 已連上，但信使 CourierServer 可能剛掛上（inbound 不緩衝晚訂閱者）→ 重試跨越該視窗。
        const res = await retry(() =>
          client!.reconcile(roomId, localStore, floorMap, (m) => {
            void deps.saveRecord(roomId, m).catch(() => undefined); // 落地失敗不拖垮對帳
          })
        );
        summary.rooms += 1;
        summary.received += res.received;
        summary.pushed += res.pushed;
      } catch (err) {
        logger.warn('[runCourierBackup] room reconcile failed', { roomId, err });
      }
    }
    return summary; // 用了這個可達信使，完成本輪
  }
  return summary;
}

/** 有限次重試（預設 4 次、間隔 500ms）；供對帳跨越「信使伺服器尚未掛上」的短暫視窗。 */
async function retry<T>(fn: () => Promise<T>, attempts = 4, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
