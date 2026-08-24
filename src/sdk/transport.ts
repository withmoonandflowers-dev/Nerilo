/**
 * Nerilo SDK — 遊戲/低延遲傳輸入口（subpath：`nerilo/transport`，Spec 023）。
 *
 * 給「不要聊天、只要傳輸地基」的嵌入者：mesh 連線＋身分＋房間金鑰照舊成形，
 * 但不建 MeshChatService——訊息層的恰好一次、去重、歷史、儲存全部不進來。
 * 在已成形的 peer 連線上開 raw DataChannel（參數直通 WebRTC 原生語義），
 * 資料以房間金鑰 AES-GCM 密封（Q1 拍板：強制加密；金鑰未就緒＝丟棄＋計數，不排隊）。
 *
 * 誠實邊界：
 *  - 無可靠性保證：不去重、不補送、不保序（除非你開 ordered 通道）。掉了就掉，
 *    計數器看得到（fail-visible）。遊戲的 input 冗餘視窗是你的事。
 *  - 通道生命週期綁 mesh 連線：mesh 重連時通道跟著斷（onClose 透出），重開由你決定。
 */

import { MeshGossipManager } from '../core/mesh/MeshGossipManager';
import { sealRawFrame, openRawFrame, type RawPayload, type RawKeyPort } from '../core/p2p/RawChannelCrypto';
import { deriveStatus, statusEquals, type NeriloStatus } from '../core/messaging/status';
import type { SignalingFactory } from '../core/p2p/SignalingTransport.types';
import type { IRoomDirectory } from '../ports';
import { logger } from '../utils/logger';

export type { RawPayload, NeriloStatus };

export interface RawChannelInit {
  ordered?: boolean;
  maxRetransmits?: number;
  maxPacketLifeTime?: number;
}

export interface RawChannel {
  readonly peerId: string;
  readonly label: string;
  /** 送出（同步門面；內部序列化密封以保 ordered 通道的順序）。不可送＝丟棄＋計數。 */
  send(data: RawPayload): void;
  onMessage(cb: (data: RawPayload, from: string) => void): () => void;
  onClose(cb: () => void): () => void;
  /** 送出側被丟棄的計數（通道未開／金鑰未就緒／密封失敗）。 */
  dropped(): number;
  /** 接收側被丟棄的計數（無該代金鑰／驗證失敗／格式不符）。 */
  droppedInbound(): number;
  close(): void;
}

class RawChannelImpl implements RawChannel {
  private msgListeners = new Set<(data: RawPayload, from: string) => void>();
  private closeListeners = new Set<() => void>();
  private outDropped = 0;
  private inDropped = 0;
  /** 密封序列化鏈：保證 ordered 通道上 frame 依 send 呼叫順序出去。 */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    readonly peerId: string,
    readonly label: string,
    private dc: RTCDataChannel,
    private keys: RawKeyPort
  ) {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      void (async () => {
        try {
          const payload = await openRawFrame(this.keys, new Uint8Array(ev.data as ArrayBuffer));
          this.msgListeners.forEach((l) => {
            try { l(payload, this.peerId); } catch (error) {
              logger.error('[RawChannel] listener error', { label: this.label, error });
            }
          });
        } catch (error) {
          this.inDropped++;
          logger.warn('[RawChannel] inbound frame dropped', { label: this.label, error });
        }
      })();
    };
    dc.onclose = () => {
      this.closeListeners.forEach((l) => {
        try { l(); } catch { /* ignore */ }
      });
    };
  }

  send(data: RawPayload): void {
    this.sendChain = this.sendChain.then(async () => {
      if (this.dc.readyState !== 'open') {
        this.outDropped++;
        return;
      }
      const frame = await sealRawFrame(this.keys, data);
      if (frame === null) {
        this.outDropped++; // 金鑰未就緒：丟棄不排隊（Spec 023 Q1）
        return;
      }
      if (this.dc.readyState !== 'open') {
        this.outDropped++;
        return;
      }
      // frame 是密封時新配的精準大小 buffer，直接送底層 ArrayBuffer（TS DOM 型別不收 ArrayBufferLike 視圖）
      this.dc.send(frame.buffer as ArrayBuffer);
    }).catch((error) => {
      this.outDropped++;
      logger.warn('[RawChannel] send dropped', { label: this.label, error });
    });
  }

  onMessage(cb: (data: RawPayload, from: string) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  dropped(): number { return this.outDropped; }
  droppedInbound(): number { return this.inDropped; }

  close(): void {
    try { this.dc.close(); } catch { /* ignore */ }
  }
}

const OPEN_TIMEOUT_MS = 10_000;

export class NeriloTransportClient {
  private channels = new Set<RawChannelImpl>();
  private rawListeners = new Set<(ch: RawChannel) => void>();
  private peerListeners = new Set<(peers: string[]) => void>();
  private statusListeners = new Set<(s: NeriloStatus) => void>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastPeers = '';
  private lastStatus: NeriloStatus | null = null;
  private wiredManagers = new WeakSet<object>();
  private disposed = false;

  constructor(private manager: MeshGossipManager) {}

  async connect(): Promise<void> {
    await this.manager.initialize();
    this.startPoll();
  }

  /** 本機 mesh 身分（connect 後才有值）。 */
  get userId(): string | null {
    return this.manager.getUserId();
  }

  /** 目前可達（可送）的 peer 清單。 */
  peers(): string[] {
    return this.manager.getConnectedNeighborIds();
  }

  onPeerChange(cb: (peers: string[]) => void): () => void {
    this.peerListeners.add(cb);
    return () => this.peerListeners.delete(cb);
  }

  /** 狀態（語彙同主入口的 NeriloStatus；Spec 024）。 */
  getStatus(): NeriloStatus {
    const n = this.manager.isInitialized() ? this.manager.getConnectionState() : null;
    const conn = !n ? 'idle' : n.neighborCount > 0 ? 'connected' : n.totalNeighbors > 0 ? 'connecting' : 'idle';
    return deriveStatus(conn, this.manager.getEncryptionState());
  }

  onStatus(cb: (s: NeriloStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.getStatus());
    return () => this.statusListeners.delete(cb);
  }

  /**
   * 對指定 peer 開 raw 通道（主動側）。peer 未連上＝直接拋錯（不排隊，語義同 Q1）。
   * init 直通 DataChannel 原生語義；resolve 時通道已 open。
   */
  async openRawChannel(peerId: string, label: string, init?: RawChannelInit): Promise<RawChannel> {
    const conn = this.manager.getNeighborConnection(peerId);
    if (!conn) throw new Error(`peer not connected: ${peerId}`);
    const keys = this.manager.getContentKeyRing();
    if (!keys) throw new Error('room key ring unavailable (mesh not initialized)');
    const dc = conn.getP2PManager().openRawDataChannel(label, init);
    await new Promise<void>((resolve, reject) => {
      if (dc.readyState === 'open') return resolve();
      const timer = setTimeout(() => reject(new Error(`raw channel open timeout: ${label}`)), OPEN_TIMEOUT_MS);
      dc.onopen = () => { clearTimeout(timer); resolve(); };
      dc.onerror = () => { clearTimeout(timer); reject(new Error(`raw channel failed to open: ${label}`)); };
    });
    const ch = new RawChannelImpl(peerId, label, dc, keys);
    this.channels.add(ch);
    return ch;
  }

  /** 被動側：對端開 raw 通道時收到（block-brawl 型態：host 開、guest 收）。 */
  onRawChannel(cb: (ch: RawChannel) => void): () => void {
    this.rawListeners.add(cb);
    return () => this.rawListeners.delete(cb);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.poll !== null) { clearInterval(this.poll); this.poll = null; }
    this.channels.forEach((c) => c.close());
    this.channels.clear();
    this.rawListeners.clear();
    this.peerListeners.clear();
    this.statusListeners.clear();
    await this.manager.cleanup();
  }

  /** 週期性：接線新鄰居的入站 raw 通道接收者、廣播 peer 與狀態變化。 */
  private startPoll(): void {
    this.wireInbound();
    this.poll = setInterval(() => {
      this.wireInbound();
      const peers = this.peers();
      const key = peers.slice().sort().join(',');
      if (key !== this.lastPeers) {
        this.lastPeers = key;
        this.peerListeners.forEach((l) => { try { l(peers); } catch { /* ignore */ } });
      }
      const s = this.getStatus();
      if (this.lastStatus === null || !statusEquals(this.lastStatus, s)) {
        this.lastStatus = s;
        this.statusListeners.forEach((l) => { try { l(s); } catch { /* ignore */ } });
      }
    }, 300);
  }

  private wireInbound(): void {
    for (const peerId of this.manager.getConnectedNeighborIds()) {
      const conn = this.manager.getNeighborConnection(peerId);
      if (!conn) continue;
      const pm = conn.getP2PManager();
      if (this.wiredManagers.has(pm)) continue;
      this.wiredManagers.add(pm);
      pm.onRawDataChannel((label, dc) => {
        const keys = this.manager.getContentKeyRing();
        if (!keys) { dc.close(); return; }
        const ch = new RawChannelImpl(peerId, label, dc, keys);
        this.channels.add(ch);
        this.rawListeners.forEach((l) => {
          try { l(ch); } catch (error) {
            logger.error('[NeriloTransportClient] onRawChannel listener error', { error });
          }
        });
      });
    }
  }
}

/**
 * 建 transport client。signaling／directory 可注入（省略＝延遲載入 Firestore 預設，
 * 比照 `nerilo/firestore` 的縫語義）；不含 storage——transport 層無訊息持久化。
 */
export async function createTransportClient(config: {
  roomId: string;
  userId: string;
  signaling?: SignalingFactory;
  directory?: IRoomDirectory;
}): Promise<NeriloTransportClient> {
  const manager = new MeshGossipManager(config.roomId, config.userId, config.signaling, config.directory);
  return new NeriloTransportClient(manager);
}
