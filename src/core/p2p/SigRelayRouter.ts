/**
 * SigRelayRouter — 暖 mesh 中繼 signaling 的節點路由器（Spec 005 T3）。
 *
 * 每個節點一顆，實作 `SignalRelayBus`（PeerRelaySignalingTransport 的承載縫），
 * 把已封的 SignalEnvelope 沿「已建立的 mesh DataChannel」遞送：
 *
 *   發起方 ── relay(env{to:T}) ──▶ 介紹人 X（暖鄰居）──轉發──▶ T
 *
 * 職責與保證：
 *  - 介紹人只依 `to` 轉發密文（讀不到、改不了——那是 SignalEnvelope 的密碼學保證）。
 *  - hop 上限 1：介紹人只轉給「自己的直連暖鄰居」，不再擴散（房內 full-mesh 下一跳必達；
 *    到不了就 NACK，讓發起方退 Firestore——不做洪泛，signaling 不該有放大係數）。
 *  - hop-by-hop ACK/NACK：介紹人轉上開著的 bus 即 ACK、無路即 NACK；發起方逐一試每個
 *    暖鄰居，全滅或逾時 → relay() reject → 上層（WarmColdSignalingTransport）退 Firestore。
 *  - 回放緩衝：入站信封短暫保留，晚一步才 subscribe 的收端（manager 尚未建好）能補收，
 *    鏡像 Firestore signaling 的 lookback 語義；去重由 manager 的 signalId 承擔。
 *
 * 承載是誰（P2PChannelBus ns='sigrelay'）由 attachNeighbor 注入的 link 決定，
 * 本檔零 I/O、零 firebase、可決定性單元測。
 */
import type { SignalEnvelope } from './SignalEnvelope';
import type { SignalRelayBus } from './PeerRelaySignalingTransport';
import { logger } from '../../utils/logger';

/** sigrelay 線上訊息（P2PEnvelope.payload 的形狀；type 對應 P2PEnvelope.type）。 */
export type SigRelayWire =
  | { kind: 'env'; env: SignalEnvelope; hops: number }
  | { kind: 'ack'; ref: string }
  | { kind: 'nack'; ref: string; reason: string };

/** 一條到暖鄰居的收送通道（生產＝MeshConnection 的 sigrelay ns；測試＝記憶體）。 */
export interface SigRelayLink {
  /** 通道現在可送（DataChannel open）。 */
  isOpen(): boolean;
  /** 送一則 wire 訊息（通道不可用時應 reject）。 */
  send(wire: SigRelayWire): Promise<void>;
  /** 訂閱對方送來的 wire 訊息；回傳取消訂閱。 */
  onWire(handler: (wire: SigRelayWire) => void): () => void;
}

/** 介紹人 ACK 等待上限：NACK 通常毫秒級，逾時代表介紹人半死 → 試下一位/退 Firestore。 */
const ACK_TIMEOUT_MS = 2_500;
/** 入站回放緩衝：容量與時效（鏡像 Firestore lookback 的精神，量級小得多——握手短命）。 */
const REPLAY_CAP = 64;
const REPLAY_TTL_MS = 60_000;

interface BufferedEnv {
  env: SignalEnvelope;
  at: number;
}

export class SigRelayRouter implements SignalRelayBus {
  private links = new Map<string, { link: SigRelayLink; unsub: () => void }>();
  private inboundHandlers = new Set<(env: SignalEnvelope) => void | Promise<void>>();
  private replay: BufferedEnv[] = [];
  private pendingAcks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(
    private readonly localUid: string,
    private readonly now: () => number = Date.now
  ) {}

  /** 有任一開著的暖鄰居（selector 據此決定 warm 路徑是否存在）。 */
  hasOpenNeighbors(): boolean {
    for (const { link } of this.links.values()) if (link.isOpen()) return true;
    return false;
  }

  /** 掛上一條到暖鄰居的通道；重複掛同 uid 會替換舊 link（rejoin 換新 bus）。回傳卸除。 */
  attachNeighbor(remoteUid: string, link: SigRelayLink): () => void {
    this.links.get(remoteUid)?.unsub();
    const unsub = link.onWire((wire) => this.handleWire(remoteUid, wire));
    this.links.set(remoteUid, { link, unsub });
    return () => {
      const cur = this.links.get(remoteUid);
      if (cur?.link === link) {
        cur.unsub();
        this.links.delete(remoteUid);
      }
    };
  }

  // ── SignalRelayBus ──────────────────────────────────────────────────────────

  /**
   * 遞送一則信封到 env.to：直連暖鄰居優先，否則逐一請暖鄰居當介紹人轉發。
   * 全部無路/NACK/逾時 → reject（上層退 Firestore）。
   */
  async relay(env: SignalEnvelope): Promise<void> {
    const ref = `${env.from}-${env.nonce}`;
    const tried: string[] = [];

    // 直連優先：to 就是我的暖鄰居（rejoin 重協商等情境），一跳都不用。
    const direct = this.links.get(env.to);
    if (direct?.link.isOpen()) {
      await this.sendAndAwaitAck(direct.link, { kind: 'env', env, hops: 0 }, ref);
      return;
    }

    // 介紹人：逐一試每個開著的暖鄰居（不並發——避免多路徑重複遞送的無謂流量；
    // NACK 毫秒級，序列嘗試代價低）。
    for (const [uid, { link }] of this.links) {
      if (uid === env.to || !link.isOpen()) continue;
      tried.push(uid);
      try {
        await this.sendAndAwaitAck(link, { kind: 'env', env, hops: 0 }, ref);
        return;
      } catch {
        // 這位介紹人不通（NACK/逾時），試下一位。
      }
    }
    throw new Error(
      `SigRelayRouter: 無暖路徑可達 ${env.to}（試過 ${tried.length ? tried.join(',') : '無鄰居'}）`
    );
  }

  onInbound(handler: (env: SignalEnvelope) => void | Promise<void>): () => void {
    this.inboundHandlers.add(handler);
    // 回放緩衝內未過期的入站信封（晚訂閱者補收；重複由 manager signalId 去重）。
    const cutoff = this.now() - REPLAY_TTL_MS;
    for (const b of this.replay) {
      if (b.at >= cutoff) void handler(b.env);
    }
    return () => {
      this.inboundHandlers.delete(handler);
    };
  }

  dispose(): void {
    for (const { unsub } of this.links.values()) unsub();
    this.links.clear();
    this.inboundHandlers.clear();
    this.replay = [];
    for (const { reject } of this.pendingAcks.values()) {
      reject(new Error('SigRelayRouter disposed'));
    }
    this.pendingAcks.clear();
  }

  // ── 內部 ────────────────────────────────────────────────────────────────────

  private async sendAndAwaitAck(link: SigRelayLink, wire: SigRelayWire, ref: string): Promise<void> {
    const ackPromise = new Promise<void>((resolve, reject) => {
      // 同 ref 併發等待不會發生（manager 逐 signal 串行送）；後到覆蓋前者是安全簡化。
      this.pendingAcks.set(ref, { resolve, reject });
    });
    const timer = setTimeout(() => {
      const p = this.pendingAcks.get(ref);
      if (p) {
        this.pendingAcks.delete(ref);
        p.reject(new Error(`SigRelayRouter: ACK 逾時（${ACK_TIMEOUT_MS}ms）`));
      }
    }, ACK_TIMEOUT_MS);
    try {
      await link.send(wire);
      await ackPromise;
    } finally {
      clearTimeout(timer);
      this.pendingAcks.delete(ref);
    }
  }

  private handleWire(fromUid: string, wire: SigRelayWire): void {
    // 來源是遠端 peer（不可信）：形狀不對直接丟，別讓畸形 payload 炸 handler。
    if (!wire || typeof wire !== 'object' || typeof (wire as { kind?: unknown }).kind !== 'string') {
      return;
    }
    if (wire.kind === 'env') {
      const env = (wire as { env?: unknown }).env as Record<string, unknown> | undefined;
      if (
        !env ||
        typeof env.from !== 'string' ||
        typeof env.to !== 'string' ||
        typeof env.nonce !== 'string' ||
        typeof (wire as { hops?: unknown }).hops !== 'number'
      ) {
        return;
      }
    } else if (typeof (wire as { ref?: unknown }).ref !== 'string') {
      return;
    }
    switch (wire.kind) {
      case 'ack': {
        const p = this.pendingAcks.get(wire.ref);
        if (p) {
          this.pendingAcks.delete(wire.ref);
          p.resolve();
        }
        return;
      }
      case 'nack': {
        const p = this.pendingAcks.get(wire.ref);
        if (p) {
          this.pendingAcks.delete(wire.ref);
          p.reject(new Error(`SigRelayRouter: 介紹人 NACK（${wire.reason}）`));
        }
        return;
      }
      case 'env':
        void this.handleEnvelope(fromUid, wire);
        return;
      default:
        // 未知 kind：忽略（向前相容）。
        return;
    }
  }

  private async handleEnvelope(fromUid: string, wire: { env: SignalEnvelope; hops: number }): Promise<void> {
    const { env, hops } = wire;
    const ref = `${env.from}-${env.nonce}`;
    const sender = this.links.get(fromUid);

    if (env.to === this.localUid) {
      // 給我的：ACK 回上一跳，進回放緩衝，派發給訂閱者（開信封/驗簽在 transport 層）。
      void sender?.link.send({ kind: 'ack', ref }).catch(() => {});
      this.replay.push({ env, at: this.now() });
      const cutoff = this.now() - REPLAY_TTL_MS;
      while (this.replay.length > REPLAY_CAP || (this.replay[0] && this.replay[0].at < cutoff)) {
        this.replay.shift();
      }
      for (const h of this.inboundHandlers) void h(env);
      return;
    }

    // 介紹人角色：只轉一跳、只轉給直連暖鄰居；到不了就 NACK（發起方退 Firestore）。
    if (hops >= 1) {
      void sender?.link.send({ kind: 'nack', ref, reason: 'hop 上限' }).catch(() => {});
      return;
    }
    const next = this.links.get(env.to);
    if (!next?.link.isOpen()) {
      void sender?.link.send({ kind: 'nack', ref, reason: `未直連 ${env.to}` }).catch(() => {});
      return;
    }
    try {
      await next.link.send({ kind: 'env', env, hops: hops + 1 });
      // 轉上開著的 bus 即視為交付成功（hop-by-hop 語義）；ACK 回發起方。
      void sender?.link.send({ kind: 'ack', ref }).catch(() => {});
      logger.debug('[SigRelayRouter] 已中繼信封', { from: env.from, to: env.to, room: env.room });
    } catch (err) {
      void sender?.link.send({ kind: 'nack', ref, reason: '轉發失敗' }).catch(() => {});
      logger.warn('[SigRelayRouter] 轉發失敗', { to: env.to, err });
    }
  }
}
