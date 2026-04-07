import type { ChannelKind } from '../../types';
import { FirestoreRelay } from './FirestoreRelay';

const HIGH_WATERMARK: Record<ChannelKind, number> = {
  bulk: 16 * 1024 * 1024,  // 16 MB
  control: 256 * 1024,      // 256 KB
  gossip: 256 * 1024,       // 256 KB
};

const LOW_WATERMARK: Record<ChannelKind, number> = {
  bulk: HIGH_WATERMARK.bulk / 2,
  control: HIGH_WATERMARK.control / 2,
  gossip: HIGH_WATERMARK.gossip / 2,
};

type MessageHandler = (peerId: string, kind: ChannelKind, data: string | ArrayBuffer) => void;

/**
 * Envelope 簽名 Middleware
 *
 * 輸入：原始 JSON 字串（不含 sig 欄位）
 * 輸出：Base64 簽名字串（將被注入至 Envelope.sig）
 *
 * 實作範例（搭配 SecurityManager）：
 *   bus.setSignMiddleware(async (json) => {
 *     const sig = await securityManager.signEnvelopeJson(json, privateKey);
 *     return sig;
 *   });
 */
export type SignMiddleware = (jsonWithoutSig: string) => Promise<string>;

/**
 * Envelope 驗簽 Middleware
 *
 * 輸入：收到的完整原始 JSON 字串（含 sig 欄位）
 * 輸出：true = 驗簽通過；false = 驗簽失敗（訊息將被丟棄）
 *
 * 未設定時，所有訊息都視為通過驗證。
 */
export type VerifyMiddleware = (rawJson: string) => Promise<boolean>;

export class MultiChannelBus {
  private channels = new Map<string, Map<ChannelKind, RTCDataChannel>>();
  private paused = new Set<string>();
  private messageHandlers: MessageHandler[] = [];

  /** Firestore relay fallback for NAT-traversal failures */
  private firestoreRelay: FirestoreRelay | null = null;
  /** Peers currently using Firestore relay instead of WebRTC */
  private relayPeers = new Set<string>();
  /** Room ID (required for relay) */
  private roomId: string | null = null;
  /** Local user ID (required for relay) */
  private localUid: string | null = null;

  /**
   * 簽名 Middleware（選填）
   * 設定後，sendSigned() 會在送出前注入 sig 欄位。
   * send() 不會自動簽名，以維持向後相容。
   */
  private signMiddleware: SignMiddleware | null = null;

  /**
   * 驗簽 Middleware（選填）
   * 設定後，收到的所有文字訊息都會先驗簽，失敗則靜默丟棄。
   */
  private verifyMiddleware: VerifyMiddleware | null = null;

  // ── Middleware API ───────────────────────────────────────────────────────────

  /**
   * 設定 Envelope 簽名 Middleware。
   * 啟用後，透過 sendSigned() 發送的訊息會在送出前注入 sig 欄位。
   */
  setSignMiddleware(fn: SignMiddleware): void {
    this.signMiddleware = fn;
  }

  /**
   * 設定 Envelope 驗簽 Middleware。
   * 啟用後，所有收到的文字訊息都會先驗簽，失敗則靜默丟棄（不傳給 messageHandlers）。
   * 適用於 control / gossip channel；bulk channel 的 ArrayBuffer 不驗簽。
   */
  setVerifyMiddleware(fn: VerifyMiddleware): void {
    this.verifyMiddleware = fn;
  }

  // ── Firestore Relay Fallback ────────────────────────────────────────────────

  /**
   * Enable Firestore relay fallback for a specific room.
   * Called when WebRTC fails for a peer (ICE state = 'failed').
   */
  enableRelayFallback(roomId: string, localUid: string): void {
    this.roomId = roomId;
    this.localUid = localUid;
    if (!this.firestoreRelay) {
      this.firestoreRelay = new FirestoreRelay();
      this.firestoreRelay.startCleanup(roomId);
      // Subscribe to relay messages
      this.firestoreRelay.subscribe(roomId, localUid, (from, payload) => {
        for (const handler of this.messageHandlers) {
          handler(from, 'control', payload);
        }
      });
    }
  }

  /**
   * Mark a peer as using relay (WebRTC failed).
   * send() will route through Firestore for this peer.
   */
  addRelayPeer(peerId: string): void {
    this.relayPeers.add(peerId);
    console.log('[MultiChannelBus] Peer added to relay fallback', { peerId });
  }

  /** Remove a peer from relay (WebRTC reconnected) */
  removeRelayPeer(peerId: string): void {
    this.relayPeers.delete(peerId);
  }

  // ── Channel Registration ─────────────────────────────────────────────────────

  register(peerId: string, kind: ChannelKind, channel: RTCDataChannel): void {
    if (!this.channels.has(peerId)) {
      this.channels.set(peerId, new Map());
    }
    const peerChannels = this.channels.get(peerId)!;
    peerChannels.set(kind, channel);
    this.setupBackpressure(peerId, channel, kind);

    // 使用 async 訊息處理器以支援驗簽 middleware
    channel.onmessage = async (event: MessageEvent) => {
      const raw = event.data as string | ArrayBuffer;

      // 驗簽：僅對文字訊息套用；ArrayBuffer（檔案分片）不驗簽
      if (this.verifyMiddleware && typeof raw === 'string') {
        let verified = false;
        try {
          verified = await this.verifyMiddleware(raw);
        } catch (err) {
          console.warn('[MultiChannelBus] verifyMiddleware threw, dropping message', {
            peerId,
            kind,
            error: err,
          });
          return; // 驗簽錯誤視為失敗，丟棄訊息
        }

        if (!verified) {
          console.warn('[MultiChannelBus] Signature verification failed, dropping message', {
            peerId,
            kind,
          });
          return;
        }
      }

      for (const handler of this.messageHandlers) {
        handler(peerId, kind, raw);
      }
    };
  }

  unregister(peerId: string): void {
    const peerChannels = this.channels.get(peerId);
    if (peerChannels) {
      for (const channel of peerChannels.values()) {
        channel.onmessage = null;
        channel.onbufferedamountlow = null;
      }
    }
    this.channels.delete(peerId);
    this.paused.delete(peerId);
  }

  send(peerId: string, kind: ChannelKind, data: string | ArrayBuffer): void {
    // Relay fallback: if peer is on relay and data is a string (control/chat), route via Firestore
    if (
      this.relayPeers.has(peerId) &&
      this.firestoreRelay &&
      this.roomId &&
      this.localUid &&
      typeof data === 'string' &&
      (kind === 'control' || kind === 'gossip')
    ) {
      this.firestoreRelay
        .send(this.roomId, peerId, this.localUid, data)
        .catch((err) => {
          console.warn(`[MultiChannelBus] Relay send failed for peer ${peerId}`, err);
        });
      return;
    }

    if (this.paused.has(peerId)) {
      console.warn(
        `[MultiChannelBus] Peer ${peerId} is paused due to backpressure, dropping ${kind} message`
      );
      return;
    }
    const peerChannels = this.channels.get(peerId);
    if (!peerChannels) {
      throw new Error(`[MultiChannelBus] No channels registered for peer ${peerId}`);
    }
    const channel = peerChannels.get(kind);
    if (!channel) {
      throw new Error(
        `[MultiChannelBus] No ${kind} channel registered for peer ${peerId}`
      );
    }
    if (channel.readyState !== 'open') {
      console.warn(
        `[MultiChannelBus] Channel ${kind} for peer ${peerId} is not open (state: ${channel.readyState})`
      );
      return;
    }

    channel.send(data as string);

    // Check backpressure AFTER sending
    if (channel.bufferedAmount > HIGH_WATERMARK[kind]) {
      this.paused.add(peerId);
      console.warn(
        `[MultiChannelBus] Backpressure: pausing peer ${peerId} on ${kind} channel (buffered: ${channel.bufferedAmount})`
      );
    }
  }

  broadcast(kind: ChannelKind, data: string | ArrayBuffer, exclude?: string): void {
    for (const peerId of this.channels.keys()) {
      if (exclude && peerId === exclude) continue;
      try {
        this.send(peerId, kind, data);
      } catch {
        console.warn(`[MultiChannelBus] Failed to broadcast to peer ${peerId}`);
      }
    }
  }

  // ── Signed send（需先設定 signMiddleware）─────────────────────────────────

  /**
   * 以簽名方式發送文字訊息：
   * 1. 解析 JSON → 移除現有 sig → 序列化 → 計算簽名
   * 2. 將 sig 注入回 JSON → 呼叫 send()
   *
   * 若 signMiddleware 未設定，行為與 send() 相同（無簽名送出）。
   * 若簽名失敗，仍會送出（但無 sig 欄位），並記錄警告。
   */
  async sendSigned(peerId: string, kind: ChannelKind, jsonData: string): Promise<void> {
    const prepared = await this.prepareSignedJson(jsonData);
    this.send(peerId, kind, prepared);
  }

  /**
   * 以簽名方式廣播文字訊息（一次簽名，廣播給所有已連線 peer）
   */
  async broadcastSigned(kind: ChannelKind, jsonData: string, exclude?: string): Promise<void> {
    // 只簽一次，廣播給所有 peer
    const prepared = await this.prepareSignedJson(jsonData);
    this.broadcast(kind, prepared, exclude);
  }

  /**
   * 對 JSON 字串進行簽名處理：移除現有 sig → 計算簽名 → 注入 sig
   * 若 signMiddleware 未設定，直接回傳原始 JSON。
   */
  private async prepareSignedJson(jsonData: string): Promise<string> {
    if (!this.signMiddleware) return jsonData;

    try {
      // 移除現有 sig，以確保簽名內容的確定性
      const parsed = JSON.parse(jsonData) as Record<string, unknown>;
      const { sig: _sig, ...withoutSig } = parsed; // eslint-disable-line @typescript-eslint/no-unused-vars
      const canonicalJson = JSON.stringify(withoutSig);

      const sig = await this.signMiddleware(canonicalJson);

      // 注入簽名
      withoutSig.sig = sig;
      return JSON.stringify(withoutSig);
    } catch (err) {
      console.warn('[MultiChannelBus] prepareSignedJson: signing failed, sending unsigned', err);
      return jsonData;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  getChannel(peerId: string, kind: ChannelKind): RTCDataChannel | undefined {
    return this.channels.get(peerId)?.get(kind);
  }

  isConnected(peerId: string): boolean {
    const peerChannels = this.channels.get(peerId);
    if (!peerChannels || peerChannels.size === 0) return false;
    for (const channel of peerChannels.values()) {
      if (channel.readyState !== 'open') return false;
    }
    return true;
  }

  connectedPeers(): string[] {
    return Array.from(this.channels.keys()).filter((peerId) => this.isConnected(peerId));
  }

  private setupBackpressure(peerId: string, channel: RTCDataChannel, _kind: ChannelKind): void {
    const lwm = LOW_WATERMARK[_kind];
    channel.bufferedAmountLowThreshold = lwm;

    channel.onbufferedamountlow = () => {
      if (this.paused.has(peerId)) {
        this.paused.delete(peerId);
      }
    };
  }
}
