/**
 * PeerRelaySignalingTransport — 暖 mesh 中繼的 signaling 傳輸（Spec 005 T2，p2p2p 自主連線）。
 *
 * 一旦連上任一 peer，之後要連的新對象改由既有 peer 介紹（peer 中繼 signaling），
 * 完全不經我方伺服器。介紹人是不可信管道：本傳輸把 SDP 封成 SignalEnvelope（T1）——
 * 對收端 ECDH 加密、以發起方身分金鑰簽章——交給 mesh 依 `to` 遞送。介紹人只能依 `to`
 * 轉密文，讀不到（無收端 ECDH 私鑰）、改了就簽章失效（收端驗簽拒收，不建立錯誤連線）。
 *
 * 對 P2PConnectionManager 而言，這只是換掉 signaling 的「傳輸位置」（同 SignalingTransport
 * 契約），連線本體、perfect-negotiation、mutex、去重全部複用，不重寫半套 WebRTC。
 * 承載（SignalRelayBus）與傳輸位置分家：mesh 版用 P2PChannelBus ns='sigrelay'、
 * 測試版用記憶體多節點路由，皆可注入。本檔零 I/O、零 firebase，可決定性單元測。
 */
import {
  sealSignal,
  openSignal,
  type SignalEnvelope,
  type SignalKind,
  type SignFn,
  type VerifyFn,
} from './SignalEnvelope';
import type { RawSignalDoc, SignalingTransport } from './SignalingTransport.types';
import { logger } from '../../utils/logger';

/**
 * 暖 mesh 中繼匯流排：把已封信封依 `env.to` 遞送（可能經一或多個暖中繼）。
 * 承載形狀由實作決定（生產：P2PChannelBus ns='sigrelay'；測試：記憶體節點圖），
 * 中繼一律只依 `to` 轉密文，不解讀內容。
 */
export interface SignalRelayBus {
  /**
   * 交一則已封信封給 mesh 遞送（依 env.to 找暖路徑，可能經中繼）。
   * 回傳 Promise 的實作（如 SigRelayRouter 的 ACK/NACK）其 rejection＝「無暖路徑」，
   * 是上層退回 Firestore 的觸發訊號——send 必須 await 它。
   */
  relay(env: SignalEnvelope): void | Promise<void>;
  /** 訂閱 `to === 本機` 的入站信封（handler 可為 async，承載層可據回傳的 promise 排程）；回傳取消訂閱。 */
  onInbound(handler: (env: SignalEnvelope) => void | Promise<void>): () => void;
}

/** 本機 signaling 身分：收信用自己的 ECDH 私鑰協商解密、發信另以身分私鑰簽章。 */
export interface LocalSignalIdentity {
  nodeId: string;
  /** 本機 ECDH 私鑰（發信協商 + 收信解密同一把）。 */
  ecdhPrivateKey: CryptoKey;
  /** 本機 ECDH 金鑰世代（寫入信封 epoch，供收端選鑰、向下相容輪替）。 */
  epoch: number;
  /** 以身分（ECDSA）私鑰簽 canonical 字串。 */
  sign: SignFn;
}

/** 解析對象公鑰：發信需對方 ECDH 公鑰（加密）；收信需對方身分驗簽函式（驗來源）。 */
export interface PeerKeyResolver {
  /** 取 nodeId 的 ECDH 公鑰（封信給它用）。 */
  ecdhPublicOf(nodeId: string): Promise<CryptoKey>;
  /** 取 nodeId 的身分驗簽函式（驗它送來的信封）。 */
  verifierOf(nodeId: string): Promise<VerifyFn>;
}

/** 時間與亂數注入（不在模組內取現在時間／亂數，利於決定性測試，對齊 SignalEnvelope）。 */
export interface SignalClock {
  now(): number;
  nonce(): string;
}

export class PeerRelaySignalingTransport implements SignalingTransport {
  constructor(
    private readonly bus: SignalRelayBus,
    private readonly local: LocalSignalIdentity,
    private readonly peers: PeerKeyResolver,
    private readonly roomId: string,
    private readonly channelLabel: string,
    private readonly clock: SignalClock,
    /**
     * mesh 每條 pair 各一傳輸實例、共用一顆 bus：限定只認來自此對象的入站信封，
     * 免把別對的 signal 餵給本連線。星型／單一對象可省略（接受任何來源）。
     */
    private readonly remoteNodeId?: string,
  ) {}

  subscribe(_cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void {
    // 中繼 signaling 即時遞送、無「回放歷史」語義，cutoffMs 不適用（承載層 TTL 負責短命）。
    // 回傳 receive 的 promise，讓承載層（測試的記憶體 mesh）可等待處理完成；生產承載忽略即 fire-and-forget。
    return this.bus.onInbound((env) => this.receive(env, onAdded));
  }

  private async receive(env: SignalEnvelope, onAdded: (raw: RawSignalDoc) => void): Promise<void> {
    // 縱深防禦：bus 應已依 to 過濾，這裡再擋一次非給我的信封。
    if (env.to !== this.local.nodeId) return;
    // mesh 每 pair 一實例：只認此 channel 對應的來源，別對的信封留給它自己的實例處理。
    if (this.remoteNodeId && env.from !== this.remoteNodeId) return;
    try {
      const verify = await this.peers.verifierOf(env.from);
      const fromEcdhPublic = await this.peers.ecdhPublicOf(env.from);
      const opened = await openSignal(
        env,
        this.local.nodeId,
        this.local.ecdhPrivateKey,
        fromEcdhPublic,
        verify,
      );
      onAdded({
        // nonce 逐信唯一 → 與 from 組成穩定去重鍵（對齊 manager processedSignalIds）。
        signalId: `nsig-${env.from}-${env.nonce}`,
        from: opened.from,
        to: env.to,
        type: opened.kind,
        payload: JSON.parse(opened.payload) as unknown,
        channelLabel: this.channelLabel,
      });
    } catch (err) {
      // 驗簽或解密失敗＝惡意介紹人竄改、或非給我的密文：丟棄，不建立錯誤連線，
      // 且不讓單一壞信封炸掉整條訂閱（其餘信封照收）。
      logger.warn('[PeerRelaySignalingTransport] 丟棄無法開啟的信封', {
        from: env.from,
        room: env.room,
        reason: (err as Error).message,
      });
    }
  }

  async send(data: Record<string, unknown>): Promise<void> {
    // manager 發起方首發 offer 時 remoteUid 尚未學到 → data.to 為 null（Firestore
    // 廣播式語義容許）。warm 是點對點加密：退用建構時綁定的 pair 對端。
    const to = (data.to as string | null | undefined) ?? this.remoteNodeId;
    if (!to) {
      // 無 data.to 也無綁定對端（星型單一 transport）＝廣播語義，不適用此傳輸。
      throw new Error('PeerRelaySignalingTransport: peer-relay 需要明確 to（點對點加密）');
    }
    const toEcdhPublic = await this.peers.ecdhPublicOf(to);
    const env = await sealSignal(
      {
        from: this.local.nodeId,
        to,
        room: this.roomId,
        kind: data.type as SignalKind,
        epoch: this.local.epoch,
        ts: this.clock.now(),
        nonce: this.clock.nonce(),
        payload: JSON.stringify(data.payload ?? {}),
      },
      this.local.ecdhPrivateKey,
      toEcdhPublic,
      this.local.sign,
    );
    // 必須 await：relay 的 NACK/無路 rejection 是「退回 Firestore」的觸發訊號，
    // 漂走會讓 send 假成功 → 上層永不退 cold → signaling 憑空消失（T6 run15 破案）。
    await this.bus.relay(env);
  }

  async cleanupOlderThan(): Promise<void> {
    /* 中繼 signaling 短命，由承載層 TTL 處理；no-op（對齊 RelaySignalingTransport）。 */
  }

  async cleanupOwn(): Promise<void> {
    /* 同上：離開清理由承載層處理；no-op。 */
  }
}
