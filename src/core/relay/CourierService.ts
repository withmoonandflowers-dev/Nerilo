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
} as const;

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
 * verifyTombstone 注入房籍/簽章驗證（本層盲，不含 crypto）；預設拒絕（安全預設）。
 */
export class CourierServer {
  private unsub: (() => void) | null = null;

  constructor(
    private readonly bus: CourierBus,
    private readonly store: CourierStore,
    private readonly selfId: string,
    private readonly verifyTombstone: (roomId: string, proof: unknown) => boolean | Promise<boolean> = () => false
  ) {}

  start(): void {
    if (this.unsub) return;
    this.unsub = this.bus.subscribe(COURIER_NS, (env) => this.onEnvelope(env));
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private async onEnvelope(env: P2PEnvelope): Promise<void> {
    if (env.from === this.selfId) return; // 不處理自己送的（bus 可能回放）
    try {
      switch (env.type) {
        case CourierMsgType.DEPOSIT: {
          const rec = env.payload as GossipMessage;
          const result = this.store.deposit(rec);
          await this.reply(env, CourierMsgType.DEPOSIT_ACK, result);
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
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS
  ) {}

  start(): void {
    if (this.unsub) return;
    this.unsub = this.bus.subscribe(COURIER_NS, (env) => {
      if (env.replyTo && this.pending.has(env.replyTo)) {
        this.pending.get(env.replyTo)!(env);
      }
    });
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
