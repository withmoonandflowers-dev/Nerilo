import { P2PConnectionManager } from './P2PConnectionManager';
import { P2PChannelBus } from './P2PChannelBus';
import { P2PProtocolRegistry } from './P2PProtocolRegistry';
import { P2PFileTransferService } from './P2PFileTransferService';
import { P2PMediaService } from './P2PMediaService';
import { generateDeviceId } from '../../utils/uuid';

export class P2PManager {
  private connectionManager: P2PConnectionManager;
  private channelBus: P2PChannelBus | null = null;
  private protocolRegistry: P2PProtocolRegistry;
  private fileTransferService: P2PFileTransferService | null = null;
  private mediaService: P2PMediaService | null = null;
  private localUid: string;
  private deviceId: string;
  private dataChannelLabel: string;
  private isInitiator: boolean;

  constructor(roomId: string, localUid: string, dataChannelLabel = 'main', isInitiator = true) {
    this.localUid = localUid;
    this.deviceId = generateDeviceId();
    this.dataChannelLabel = dataChannelLabel;
    this.isInitiator = isInitiator;
    this.connectionManager = new P2PConnectionManager(roomId, localUid);
    this.protocolRegistry = new P2PProtocolRegistry();
  }

  async initialize(): Promise<void> {
    console.log('[P2PManager] initialize called', {
      roomId: this.connectionManager['roomId'],
      localUid: this.localUid,
      isInitiator: this.isInitiator,
      dataChannelLabel: this.dataChannelLabel,
    });

    await this.connectionManager.initialize();

    const pc = this.connectionManager.getPeerConnection();
    if (!pc) throw new Error('PeerConnection not available');

    console.log('[P2PManager] PeerConnection obtained', {
      roomId: this.connectionManager['roomId'],
      connectionState: pc.connectionState,
      signalingState: pc.signalingState,
    });

    // 處理遠端 DataChannel（非 initiator 會依賴這個事件）
    pc.ondatachannel = (event) => {
      console.log('[P2PManager] DataChannel received', {
        roomId: this.connectionManager['roomId'],
        channelLabel: event.channel.label,
        expectedLabel: this.dataChannelLabel,
      });

      if (event.channel.label === this.dataChannelLabel) {
        console.log('[P2PManager] Creating ChannelBus for remote DataChannel', {
          roomId: this.connectionManager['roomId'],
        });
        this.channelBus = new P2PChannelBus(event.channel);
        this.initializeServices();
      }
    };

    if (this.isInitiator) {
      console.log('[P2PManager] Creating DataChannel as initiator', {
        roomId: this.connectionManager['roomId'],
        label: this.dataChannelLabel,
      });

      // initiator 負責建立 DataChannel 並送出 offer
      const dataChannel = pc.createDataChannel(this.dataChannelLabel, { ordered: true });
      this.channelBus = new P2PChannelBus(dataChannel);

      dataChannel.onopen = () => {
        console.log('[P2PManager] DataChannel opened', {
          roomId: this.connectionManager['roomId'],
          label: this.dataChannelLabel,
        });
        this.initializeServices();
      };

      dataChannel.onerror = (error) => {
        console.error('[P2PManager] DataChannel error', {
          roomId: this.connectionManager['roomId'],
          error,
        });
      };

      await this.connectionManager.createOffer();
      console.log('[P2PManager] Offer created and sent', {
        roomId: this.connectionManager['roomId'],
      });
    } else {
      console.log('[P2PManager] Waiting for remote DataChannel as non-initiator', {
        roomId: this.connectionManager['roomId'],
      });
    }

    console.log('[P2PManager] initialize completed', {
      roomId: this.connectionManager['roomId'],
    });
  }

  private initializeServices(): void {
    if (!this.channelBus) {
      console.warn('[P2PManager] initializeServices: ChannelBus not available', {
        roomId: this.connectionManager['roomId'],
      });
      return;
    }

    const pc = this.connectionManager.getPeerConnection();
    if (!pc) {
      console.warn('[P2PManager] initializeServices: PeerConnection not available', {
        roomId: this.connectionManager['roomId'],
      });
      return;
    }

    console.log('[P2PManager] initializeServices called', {
      roomId: this.connectionManager['roomId'],
      hasFileTransferService: !!this.fileTransferService,
      hasMediaService: !!this.mediaService,
    });

    // 初始化檔案傳輸服務
    if (!this.fileTransferService) {
      console.log('[P2PManager] Creating FileTransferService', {
        roomId: this.connectionManager['roomId'],
      });
      this.fileTransferService = new P2PFileTransferService(
        this.channelBus,
        this.localUid,
        this.deviceId
      );
    }

    // 初始化媒體服務
    if (!this.mediaService) {
      console.log('[P2PManager] Creating MediaService', {
        roomId: this.connectionManager['roomId'],
      });
      this.mediaService = new P2PMediaService(
        this.channelBus,
        pc,
        this.localUid,
        this.deviceId
      );
    }

    console.log('[P2PManager] Services initialized', {
      roomId: this.connectionManager['roomId'],
    });
  }

  getConnectionManager(): P2PConnectionManager {
    return this.connectionManager;
  }

  getChannelBus(): P2PChannelBus | null {
    return this.channelBus;
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

  async close(): Promise<void> {
    this.fileTransferService = null;
    this.mediaService = null;
    this.channelBus?.close();
    this.channelBus = null;
    await this.connectionManager.close();
  }
}



