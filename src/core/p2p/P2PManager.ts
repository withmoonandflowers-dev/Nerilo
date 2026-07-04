import { P2PConnectionManager } from './P2PConnectionManager';
import { P2PChannelBus } from './P2PChannelBus';
import { P2PProtocolRegistry } from './P2PProtocolRegistry';
import { P2PFileTransferService } from './P2PFileTransferService';
import { P2PMediaService } from './P2PMediaService';
import { StateChannel } from './StateChannel';
import { HelloNegotiator, type HelloPayload, type NegotiatedCapabilities } from './HelloNegotiator';
import { generateDeviceId } from '../../utils/uuid';
import { logger } from '../../utils/logger';
import { CHANNEL_INIT, type Envelope, type P2PEnvelope } from '../../types';

/** 不可靠狀態幀通道的 DataChannel label（ADR-0019） */
const STATE_CHANNEL_LABEL = 'state';

export class P2PManager {
  private connectionManager: P2PConnectionManager;
  private channelBus: P2PChannelBus | null = null;
  /** 不可靠二進位狀態幀通道（ADR-0019，遊戲 60Hz 狀態流用；為 null 表示尚未建立） */
  private stateChannel: StateChannel | null = null;
  private protocolRegistry: P2PProtocolRegistry;
  private fileTransferService: P2PFileTransferService | null = null;
  private mediaService: P2PMediaService | null = null;
  private helloNegotiator: HelloNegotiator | null = null;
  private localUid: string;
  private deviceId: string;
  private dataChannelLabel: string;
  private isInitiator: boolean;
  private roomId: string;
  /** 協商完成後的回呼（外部可用 onNegotiated 設定） */
  private negotiatedCallback: ((result: NegotiatedCapabilities) => void) | null = null;

  constructor(roomId: string, localUid: string, dataChannelLabel = 'main', isInitiator = true) {
    this.roomId = roomId;
    this.localUid = localUid;
    this.deviceId = generateDeviceId();
    this.dataChannelLabel = dataChannelLabel;
    this.isInitiator = isInitiator;
    this.connectionManager = new P2PConnectionManager(roomId, localUid, dataChannelLabel);
    this.protocolRegistry = new P2PProtocolRegistry();
  }

  /**
   * 設定 capability negotiation 完成後的回呼
   * 在 initialize() 之前呼叫
   */
  onNegotiated(cb: (result: NegotiatedCapabilities) => void): this {
    this.negotiatedCallback = cb;
    return this;
  }

  async initialize(): Promise<void> {
    logger.info('[P2PManager] initialize called', {
      roomId: this.connectionManager['roomId'],
      localUid: this.localUid,
      isInitiator: this.isInitiator,
      dataChannelLabel: this.dataChannelLabel,
    });

    await this.connectionManager.initialize();

    const pc = this.connectionManager.getPeerConnection();
    if (!pc) throw new Error('PeerConnection not available');

    logger.info('[P2PManager] PeerConnection obtained', {
      roomId: this.connectionManager['roomId'],
      connectionState: pc.connectionState,
      signalingState: pc.signalingState,
    });

    // 處理遠端 DataChannel（非 initiator 會依賴這個事件）
    pc.ondatachannel = (event) => {
      logger.info('[P2PManager] DataChannel received', {
        roomId: this.connectionManager['roomId'],
        channelLabel: event.channel.label,
        expectedLabel: this.dataChannelLabel,
      });

      if (event.channel.label === this.dataChannelLabel) {
        logger.info('[P2PManager] Creating ChannelBus for remote DataChannel', {
          roomId: this.connectionManager['roomId'],
        });
        this.channelBus = new P2PChannelBus(event.channel);

        // 確保 DataChannel 已 open 後才初始化 services
        if (event.channel.readyState === 'open') {
          this.initializeServices();
        } else {
          event.channel.onopen = () => {
            logger.info('[P2PManager] Remote DataChannel opened', {
              roomId: this.connectionManager['roomId'],
            });
            this.initializeServices();
          };
        }
      } else if (event.channel.label === STATE_CHANNEL_LABEL) {
        // 不可靠狀態幀通道（遠端建立，answerer 收到）
        logger.info('[P2PManager] State channel received', { roomId: this.roomId });
        this.stateChannel = new StateChannel(event.channel);
      }
    };

    if (this.isInitiator) {
      logger.info('[P2PManager] Creating DataChannel as initiator', {
        roomId: this.connectionManager['roomId'],
        label: this.dataChannelLabel,
      });

      // initiator 負責建立 DataChannel 並送出 offer
      const dataChannel = pc.createDataChannel(this.dataChannelLabel, { ordered: true });
      this.channelBus = new P2PChannelBus(dataChannel);

      // 同時建立不可靠狀態幀通道（ADR-0019）。必須在 createOffer 前建立，
      // 才會進 SDP、被對端 ondatachannel 收到。狀態流按需使用，閒置零成本。
      const stateDc = pc.createDataChannel(STATE_CHANNEL_LABEL, CHANNEL_INIT.state);
      this.stateChannel = new StateChannel(stateDc);

      dataChannel.onopen = () => {
        logger.info('[P2PManager] DataChannel opened', {
          roomId: this.connectionManager['roomId'],
          label: this.dataChannelLabel,
        });
        this.initializeServices();
      };

      dataChannel.onerror = (error) => {
        logger.error('[P2PManager] DataChannel error', {
          roomId: this.connectionManager['roomId'],
          error,
        });
      };

      await this.connectionManager.createOffer();
      logger.info('[P2PManager] Offer created and sent', {
        roomId: this.connectionManager['roomId'],
      });
    } else {
      logger.info('[P2PManager] Waiting for remote DataChannel as non-initiator', {
        roomId: this.connectionManager['roomId'],
      });
    }

    logger.info('[P2PManager] initialize completed', {
      roomId: this.connectionManager['roomId'],
    });
  }

  /** 防止 initializeServices 被多次呼叫（initiator onopen + 非 initiator ondatachannel race） */
  private servicesInitialized = false;

  private initializeServices(): void {
    // 防止重複初始化：initiator 的 onopen 和非 initiator 的 ondatachannel 可能同時觸發
    if (this.servicesInitialized) {
      logger.debug('[P2PManager] initializeServices already called, skipping', { roomId: this.roomId });
      return;
    }
    if (!this.channelBus) {
      logger.warn('[P2PManager] initializeServices: ChannelBus not available', {
        roomId: this.roomId,
      });
      return;
    }

    const pc = this.connectionManager.getPeerConnection();
    if (!pc) {
      logger.warn('[P2PManager] initializeServices: PeerConnection not available', {
        roomId: this.roomId,
      });
      return;
    }

    this.servicesInitialized = true;

    logger.info('[P2PManager] initializeServices called', {
      roomId: this.roomId,
      hasFileTransferService: !!this.fileTransferService,
      hasMediaService: !!this.mediaService,
    });

    // ── HELLO / HELLO_ACK capability negotiation ──────────────────────────
    // 在 DataChannel 開啟後立即啟動協商，讓雙方確認支援的 feature 交集。
    if (!this.helloNegotiator) {
      const selfCapabilities: HelloPayload = {
        protocolVersion: 1,
        features: ['chat', 'file', 'media'],   // 預設 built-in features
        transports: ['control', 'bulk', 'gossip', 'state'],
      };

      this.helloNegotiator = new HelloNegotiator(
        selfCapabilities,
        (env: Envelope) => {
          // 透過 channelBus 發送 HELLO / HELLO_ACK（走 control channel）
          this.channelBus?.send(env as unknown as P2PEnvelope);
        },
        `${this.localUid}/${this.deviceId}`,
        this.roomId
      );

      if (this.negotiatedCallback) {
        this.helloNegotiator.onNegotiated(this.negotiatedCallback);
      }

      this.helloNegotiator.sendHello();
    }

    // ── 檔案傳輸服務 ───────────────────────────────────────────────────────
    if (!this.fileTransferService) {
      logger.info('[P2PManager] Creating FileTransferService', { roomId: this.roomId });
      this.fileTransferService = new P2PFileTransferService(
        this.channelBus,
        this.localUid,
        this.deviceId
      );
    }

    // ── 媒體服務 ──────────────────────────────────────────────────────────
    if (!this.mediaService) {
      logger.info('[P2PManager] Creating MediaService', { roomId: this.roomId });
      this.mediaService = new P2PMediaService(
        this.channelBus,
        pc,
        this.localUid,
        this.deviceId
      );
    }

    logger.info('[P2PManager] Services initialized', { roomId: this.roomId });
  }

  getConnectionManager(): P2PConnectionManager {
    return this.connectionManager;
  }

  getChannelBus(): P2PChannelBus | null {
    return this.channelBus;
  }

  /** 不可靠狀態幀通道（遊戲 60Hz 狀態流用）。連線未建立或對端不支援時為 null。 */
  getStateChannel(): StateChannel | null {
    return this.stateChannel;
  }

  getProtocolRegistry(): P2PProtocolRegistry {
    return this.protocolRegistry;
  }

  getFileTransferService(): P2PFileTransferService | null {
    return this.fileTransferService;
  }

  getMediaService(): P2PMediaService | null {
    return this.mediaService;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getHelloNegotiator(): HelloNegotiator | null {
    return this.helloNegotiator;
  }

  async close(): Promise<void> {
    this.helloNegotiator?.dispose();
    this.helloNegotiator = null;
    // 停止媒體 tracks（避免 camera/mic LED 常亮）
    if (this.mediaService) {
      try { this.mediaService.stopLocalMedia(); } catch { /* ignore */ }
    }
    this.fileTransferService = null;
    this.mediaService = null;
    this.channelBus?.close();
    this.channelBus = null;
    this.stateChannel?.close();
    this.stateChannel = null;
    this.servicesInitialized = false;
    await this.connectionManager.close();
  }
}



