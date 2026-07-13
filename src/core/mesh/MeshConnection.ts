import { P2PManager } from '../p2p/P2PManager';
import { P2PChannelBus } from '../p2p/P2PChannelBus';
import type { SignalingFactory } from '../p2p/SignalingTransport';
import type { GossipMessage } from '../../types';
import type { GossipDigest } from './antiEntropy';
import { logger } from '../../utils/logger';

/**
 * Mesh 連線包裝類別
 * 封裝與單個鄰居的 P2P 連線
 */
/**
 * ChannelBus 就緒逾時（首次連線用）。逾時後 MeshTopologyManager 會 close + 指數退避
 * 重試。首次（含 3 人同時進場）保持耐心 30s：直連/STUN 通常數秒內完成，但多人同時
 * 協商 + TURN relay 配置偶爾會拖到十幾秒，太短會誤殺「慢但會成功」的協商 → 反而 churn
 * 到連不上（實測全域改 10s 會讓 3 人 mesh 初連 churn 逾時）。
 */
const CHANNEL_READY_TIMEOUT_MS = 30_000;

/**
 * 離開再進（rejoin）重建時的較短逾時。拆舊建新的第一次握手偶爾卡在與舊 pc 的交疊窗，
 * 早點逾時讓乾淨重試接手（最壞 rejoin 從 ~40s 壓到 ~20s）。只用在 rejoin 首次重建；
 * 之後的退避重試回到耐心的 30s，避免把「本來就要成功、只是慢」的重連也砍掉。
 * 取 15s（非 10s）：實測 rejoin 首連常落在 13-15s，10s 會把它們一併砍掉造成 churn。
 */
export const REJOIN_READY_TIMEOUT_MS = 15_000;

export class MeshConnection {
  private p2pManager: P2PManager;
  private channelBus: P2PChannelBus | null = null;
  private messageListeners: Set<(message: GossipMessage) => void> = new Set();
  private digestListeners: Set<(digest: GossipDigest) => void> = new Set();
  /**
   * 暫態信號（typing 等）監聽器。走 ns:'presence'，**不進** gossip store /
   * anti-entropy 對帳——lossy（best-effort、掉了不補），語義同星型的 TYPING。
   */
  private ephemeralListeners: Set<(env: { type: string; from?: string; payload: unknown }) => void> = new Set();
  private readyPromise: Promise<void>;
  private meshUserId: string; // 用於 Gossip 的 userId

  constructor(
    private roomId: string,
    private localFirebaseUid: string, // 用於 signaling 的 Firebase UID
    private remoteFirebaseUid: string, // 用於 signaling 的 Firebase UID
    meshUserId: string, // 用於 Gossip 的 userId
    isInitiator: boolean,
    private readyTimeoutMs: number = CHANNEL_READY_TIMEOUT_MS,
    signalingFactory?: SignalingFactory // 省略＝P2PManager 預設走 Firestore；SDK 可注入自架後端
  ) {
    this.meshUserId = meshUserId;

    // channelLabel 必須兩端一致：用排序後的 UID 組合確保對稱
    // 否則 A 的 "mesh-B" ≠ B 的 "mesh-A"，signal 會被 channelLabel 過濾掉
    const sortedUids = [localFirebaseUid, remoteFirebaseUid].sort();
    const symmetricLabel = `mesh-${sortedUids[0]}-${sortedUids[1]}`;

    // 使用 Firebase UID 進行 signaling（因為 P2PConnectionManager 依賴它）
    this.p2pManager = new P2PManager(
      roomId,
      localFirebaseUid,
      symmetricLabel,
      isInitiator,
      signalingFactory?.(roomId, symmetricLabel)
    );
    
    this.readyPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.p2pManager.initialize();

    // 等待 ChannelBus 就緒，帶有明確的 resolve/reject
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const bus = this.p2pManager.getChannelBus();
        if (bus && bus.getReadyState() === 'open') {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          this.channelBus = bus;
          this.setupMessageHandlers();
          logger.info('[MeshConnection] ChannelBus ready', {
            roomId: this.roomId,
            remoteFirebaseUid: this.remoteFirebaseUid,
            meshUserId: this.meshUserId,
          });
          resolve();
        }
      }, 200);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        logger.warn('[MeshConnection] ChannelBus not ready after timeout', {
          roomId: this.roomId,
          remoteFirebaseUid: this.remoteFirebaseUid,
          meshUserId: this.meshUserId,
        });
        reject(new Error(`MeshConnection timeout: ChannelBus not ready after ${this.readyTimeoutMs}ms`));
      }, this.readyTimeoutMs);
    });

    this.startBusRebindWatch();
  }

  /**
   * ChannelBus 換代追蹤（ADR-0023 P1 發現的斷點）：
   * 對方離開再進時，會用「同一 channelLabel」發全新 offer；本端 pc 完成重新協商後，
   * P2PManager 在 ondatachannel 換上新 bus——但本類原本把初始 bus 快取死了，
   * 訂閱掛在舊 bus、send 也送死通道 → 對方重進後訊息單向黑洞。
   * 這裡輪詢偵測 bus 實例更換，重掛訂閱。舊 bus 若仍殘留造成雙路收，
   * 由 GossipMessageHandler 的 (senderId, seq) 去重擋住，安全。
   */
  private busRebindWatch: ReturnType<typeof setInterval> | null = null;

  private startBusRebindWatch(): void {
    if (this.busRebindWatch) return;
    this.busRebindWatch = setInterval(() => {
      const bus = this.p2pManager.getChannelBus();
      if (bus && bus !== this.channelBus && bus.getReadyState() === 'open') {
        logger.info('[MeshConnection] Rebinding to new ChannelBus (peer session renewed)', {
          roomId: this.roomId,
          remoteFirebaseUid: this.remoteFirebaseUid,
          meshUserId: this.meshUserId,
        });
        this.channelBus = bus;
        this.setupMessageHandlers();
      }
    }, 1000);
  }

  /**
   * 等待連線準備就緒
   */
  async waitForReady(): Promise<void> {
    await this.readyPromise;
    if (!this.channelBus) {
      throw new Error('ChannelBus not ready');
    }
  }

  /**
   * 設置訊息處理器
   */
  private setupMessageHandlers(): void {
    if (!this.channelBus) return;

    this.channelBus.subscribe('gossip', async (envelope) => {
      if (envelope.type === 'GOSSIP_MESSAGE') {
        const message = envelope.payload as GossipMessage;
        this.messageListeners.forEach(listener => {
          try {
            listener(message);
          } catch (error) {
            logger.error('[MeshConnection] Error in message listener', { error });
          }
        });
      } else if (envelope.type === 'GOSSIP_DIGEST') {
        // anti-entropy 對帳摘要（形狀由收端 normalizeDigest 驗證）
        const digest = envelope.payload as GossipDigest;
        this.digestListeners.forEach(listener => {
          try {
            listener(digest);
          } catch (error) {
            logger.error('[MeshConnection] Error in digest listener', { error });
          }
        });
      }
    });

    // 暫態信號（typing 等）：獨立 ns，不碰 gossip store / 對帳。
    this.channelBus.subscribe('presence', async (envelope) => {
      this.ephemeralListeners.forEach(listener => {
        try {
          listener({ type: envelope.type, from: envelope.from, payload: envelope.payload });
        } catch (error) {
          logger.error('[MeshConnection] Error in ephemeral listener', { error });
        }
      });
    });
  }

  /**
   * 發送訊息
   */
  async send(message: GossipMessage): Promise<void> {
    await this.waitForReady();
    
    if (!this.channelBus) {
      throw new Error('ChannelBus not available');
    }

    const envelope = {
      v: 1,
      ns: 'gossip',
      type: 'GOSSIP_MESSAGE',
      id: `${Date.now()}-${Math.random()}`,
      ts: Date.now(),
      from: this.localFirebaseUid, // 使用 Firebase UID 進行 envelope
      to: this.remoteFirebaseUid,
      payload: message, // message 本身包含 senderId (userId)
    };

    await this.channelBus.send(envelope);
  }

  /** 送 anti-entropy digest（缺哪則的協商；訊息本體仍走 GOSSIP_MESSAGE） */
  async sendDigest(digest: GossipDigest): Promise<void> {
    await this.waitForReady();

    if (!this.channelBus) {
      throw new Error('ChannelBus not available');
    }

    await this.channelBus.send({
      v: 1,
      ns: 'gossip',
      type: 'GOSSIP_DIGEST',
      id: `${Date.now()}-${Math.random()}`,
      ts: Date.now(),
      from: this.localFirebaseUid,
      to: this.remoteFirebaseUid,
      payload: digest,
    });
  }

  /**
   * 送暫態信號（typing 等）。lossy：bus 未 open 直接丟棄，**不** waitForReady——
   * typing 遲送無意義，且不可拖住呼叫端。不進 gossip 日誌、不參與對帳。
   */
  async sendEphemeral(type: string, payload: unknown): Promise<void> {
    if (this.channelBus?.getReadyState() !== 'open') return;
    try {
      await this.channelBus.send({
        v: 1,
        ns: 'presence',
        type,
        id: `${Date.now()}-${Math.random()}`,
        ts: Date.now(),
        from: this.localFirebaseUid,
        to: this.remoteFirebaseUid,
        payload,
      });
    } catch {
      /* best-effort：掉了就掉了，下次 keystroke 再送 */
    }
  }

  /** 監聽對方送來的暫態信號（typing 等）；不受 ttl/對帳影響 */
  onEphemeral(listener: (env: { type: string; from?: string; payload: unknown }) => void): () => void {
    this.ephemeralListeners.add(listener);
    return () => {
      this.ephemeralListeners.delete(listener);
    };
  }

  /** 監聽對方送來的 digest */
  onDigest(listener: (digest: GossipDigest) => void): () => void {
    this.digestListeners.add(listener);
    return () => {
      this.digestListeners.delete(listener);
    };
  }

  /**
   * 監聽訊息
   */
  onMessage(listener: (message: GossipMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * 獲取連線 ID（返回 mesh userId）
   */
  getId(): string {
    return this.meshUserId;
  }

  /**
   * 獲取連線狀態。
   * 'connected' 的語義是「現在可以送訊息」：ICE 可能已 connected 但 ChannelBus
   * 尚未（或永遠不會）open——那種連線送訊會卡在 waitForReady。若在此謊報
   * connected，上游會（1）以為 mesh 覆蓋完整而不做備援橋接、（2）把 anti-entropy
   * digest 送進黑洞。因此 bus 未 open 一律降報為 connecting。
   */
  getState(): string {
    // DataChannel（bus）開著即為連上的真相：收發都走它。離開再進時對方 pc 重協商，
    // RTCPeerConnection.connectionState 可能不轉為 'connected'（bus 已開卻卡在 connecting）。
    if (this.channelBus?.getReadyState() === 'open') return 'connected';
    const state = this.p2pManager.getConnectionManager().getState();
    return state === 'connected' ? 'connecting' : state;
  }

  /**
   * 請求鄰居列表（用於節點發現）
   */
  async requestNeighborList(): Promise<string[]> {
    // 這裡可以實作一個協議來請求鄰居列表
    // 簡化版：返回空陣列
    return [];
  }

  /**
   * 關閉連線
   */
  async close(): Promise<void> {
    if (this.busRebindWatch) {
      clearInterval(this.busRebindWatch);
      this.busRebindWatch = null;
    }
    await this.p2pManager.close();
    this.messageListeners.clear();
    this.digestListeners.clear();
  }
}
