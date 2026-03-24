/**
 * HelloNegotiator — HELLO / HELLO_ACK Capability Negotiation
 *
 * ════════════════════════════════════════════════════════════════════════
 * 流程
 * ════════════════════════════════════════════════════════════════════════
 *
 *  DataChannel 開啟後：
 *
 *    Peer A ──HELLO(capabilities)──▶ Peer B
 *    Peer A ◀──HELLO_ACK(capabilities)── Peer B
 *
 *  雙方各自在收到對方的 HELLO / HELLO_ACK 後：
 *  - 記錄對方的 capabilities
 *  - 計算兩者的「交集」（negotiated）
 *  - 觸發 onNegotiated 回呼，上層可據此決定啟用哪些 feature
 *
 * ════════════════════════════════════════════════════════════════════════
 * Feature Negotiation 規則
 * ════════════════════════════════════════════════════════════════════════
 *
 *  negotiated.features = 雙方 features 的交集
 *  negotiated.protocolVersion = Math.min(local, remote)
 *  negotiated.transports = 本地支援的 transports（由本地自行決定）
 *
 * ════════════════════════════════════════════════════════════════════════
 * 安全
 * ════════════════════════════════════════════════════════════════════════
 *
 *  HELLO / HELLO_ACK payload 本身不含敏感資訊，僅列出 feature 清單與
 *  協議版本。若開啟了 MultiChannelBus 的 Envelope 簽名，這兩個訊息
 *  也會被自動簽名與驗證。
 */

import type { Envelope, ChannelKind } from '../../types';

// ── HelloPayload ──────────────────────────────────────────────────────────────

export interface HelloPayload {
  /** 協議版本（目前為 1） */
  protocolVersion: number;
  /**
   * 支援的 feature 清單（例如 ['chat', 'file', 'media']）
   * 對應 FeatureModule.name
   */
  features: string[];
  /** 支援的 DataChannel 類型 */
  transports: ChannelKind[];
  /**
   * 拓撲偏好（選填）
   * 上層可透過此欄位傳達「我希望使用 mesh」等意圖
   */
  topologyHint?: 'star' | 'mesh' | 'hybrid' | 'auto';
}

/** 協商結果 */
export interface NegotiatedCapabilities {
  /** 雙方都支援的 feature */
  features: string[];
  /** 取 min(local, remote)，確保向後相容 */
  protocolVersion: number;
  /** 本地支援的 transports */
  transports: ChannelKind[];
  /** 對方的完整 HelloPayload（供上層參考） */
  remote: HelloPayload;
}

/** 協商完成後的回呼 */
export type NegotiatedCallback = (result: NegotiatedCapabilities) => void;

// ── HelloNegotiator ───────────────────────────────────────────────────────────

export class HelloNegotiator {
  private acknowledged = false;
  private remoteHello: HelloPayload | null = null;
  private onNegotiatedCb: NegotiatedCallback | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param selfCapabilities  本地支援的 capabilities（送給對方的 HELLO payload）
   * @param sendFn            發送 Envelope 的函式（由 P2PManager 注入）
   * @param selfId            本地 uid / peerId
   * @param roomId            目前所在房間 ID
   * @param timeoutMs         HELLO 回應超時（預設 10 秒），超時只發出警告不斷線
   */
  constructor(
    private readonly selfCapabilities: HelloPayload,
    private readonly sendFn: (env: Envelope) => void,
    private readonly selfId: string,
    private readonly roomId: string,
    private readonly timeoutMs = 10_000
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /** 設定協商完成後的回呼 */
  onNegotiated(cb: NegotiatedCallback): this {
    this.onNegotiatedCb = cb;
    return this;
  }

  /**
   * DataChannel 開啟後呼叫：向對方發送 HELLO
   */
  sendHello(): void {
    const env: Envelope<HelloPayload> = {
      v: 1,
      ns: 'system',
      type: 'HELLO',
      id: this.generateId(),
      ts: Date.now(),
      from: this.selfId,
      roomId: this.roomId,
      payload: this.selfCapabilities,
    };

    this.sendFn(env);

    // 若對方長時間無回應，發出警告（不斷線，WebRTC 本身已有連線超時機制）
    if (this.timeoutId === null) {
      this.timeoutId = setTimeout(() => {
        if (!this.acknowledged) {
          console.warn('[HelloNegotiator] HELLO timeout — peer did not respond within', {
            roomId: this.roomId,
            timeoutMs: this.timeoutMs,
          });
        }
      }, this.timeoutMs);
    }

    console.log('[HelloNegotiator] HELLO sent', {
      roomId: this.roomId,
      selfId: this.selfId,
      features: this.selfCapabilities.features,
    });
  }

  /**
   * 由 P2PManager 在收到 DataChannel 訊息時呼叫。
   * 回傳 true 表示此訊息已由 HelloNegotiator 處理（不需再往下分派）。
   */
  handleEnvelope(env: Envelope): boolean {
    if (env.ns !== 'system') return false;

    if (env.type === 'HELLO') {
      return this.handleHello(env);
    }

    if (env.type === 'HELLO_ACK') {
      return this.handleHelloAck(env);
    }

    return false;
  }

  /** 是否已完成協商 */
  isNegotiated(): boolean {
    return this.acknowledged;
  }

  /** 取得對方的原始 HelloPayload（協商完成前為 null） */
  getRemoteCapabilities(): HelloPayload | null {
    return this.remoteHello;
  }

  /** 釋放資源（離開房間時呼叫） */
  dispose(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** 驗證遠端 HELLO payload 結構，防止 crash 或型別混淆 */
  private validateHelloPayload(payload: unknown): payload is HelloPayload {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Record<string, unknown>;
    return (
      typeof p.protocolVersion === 'number' &&
      Array.isArray(p.features) &&
      p.features.every((f: unknown) => typeof f === 'string') &&
      Array.isArray(p.transports) &&
      p.transports.every((t: unknown) => typeof t === 'string')
    );
  }

  private handleHello(env: Envelope): boolean {
    if (!this.validateHelloPayload(env.payload)) {
      console.warn('[HelloNegotiator] Invalid HELLO payload, ignored', {
        roomId: this.roomId, from: env.from,
      });
      return true; // 已消費此訊息，但不處理
    }
    this.remoteHello = env.payload as HelloPayload;

    // 回覆 HELLO_ACK
    const ack: Envelope<HelloPayload> = {
      v: 1,
      ns: 'system',
      type: 'HELLO_ACK',
      id: this.generateId(),
      ts: Date.now(),
      from: this.selfId,
      to: env.from,
      replyTo: env.id,
      roomId: this.roomId,
      payload: this.selfCapabilities,
    };

    this.sendFn(ack);

    console.log('[HelloNegotiator] HELLO received, sent HELLO_ACK', {
      roomId: this.roomId,
      from: env.from,
      remoteFeatures: this.remoteHello.features,
    });

    this.tryFinishNegotiation();
    return true;
  }

  private handleHelloAck(env: Envelope): boolean {
    if (this.remoteHello === null) {
      // 可能我們在等 HELLO，對方先送 HELLO_ACK（正常情況不會發生，防禦性處理）
      if (!this.validateHelloPayload(env.payload)) {
        console.warn('[HelloNegotiator] Invalid HELLO_ACK payload, ignored', {
          roomId: this.roomId, from: env.from,
        });
        return true;
      }
      this.remoteHello = env.payload as HelloPayload;
    }

    console.log('[HelloNegotiator] HELLO_ACK received', {
      roomId: this.roomId,
      from: env.from,
    });

    this.tryFinishNegotiation();
    return true;
  }

  private tryFinishNegotiation(): void {
    // 避免重複觸發
    if (this.acknowledged) return;
    if (this.remoteHello === null) return;

    this.acknowledged = true;

    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // 計算交集
    const localFeatureSet = new Set(this.selfCapabilities.features);
    const negotiated: NegotiatedCapabilities = {
      protocolVersion: Math.min(
        this.selfCapabilities.protocolVersion,
        this.remoteHello.protocolVersion
      ),
      features: this.remoteHello.features.filter((f) => localFeatureSet.has(f)),
      transports: this.selfCapabilities.transports,
      remote: this.remoteHello,
    };

    console.log('[HelloNegotiator] Negotiation complete', {
      roomId: this.roomId,
      negotiatedFeatures: negotiated.features,
      protocolVersion: negotiated.protocolVersion,
    });

    this.onNegotiatedCb?.(negotiated);
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID
    return `hello-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
