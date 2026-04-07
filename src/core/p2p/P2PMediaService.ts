import type { P2PEnvelope, MediaState } from '../../types';
import { P2PChannelBus } from './P2PChannelBus';
import { generateUUID } from '../../utils/uuid';

export interface MediaOptions {
  audio: boolean;
  video: boolean | MediaTrackConstraints;
}

export class P2PMediaService {
  private channelBus: P2PChannelBus;
  private peerConnection: RTCPeerConnection;
  private localUid: string;
  private deviceId: string;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private mediaState: MediaState = {
    audioEnabled: false,
    videoEnabled: false,
    audioMuted: false,
    videoMuted: false,
  };
  private stateListeners: Set<(state: MediaState) => void> = new Set();
  private streamListeners: Set<(stream: MediaStream | null) => void> = new Set();

  constructor(
    channelBus: P2PChannelBus,
    peerConnection: RTCPeerConnection,
    localUid: string,
    deviceId: string
  ) {
    this.channelBus = channelBus;
    this.peerConnection = peerConnection;
    this.localUid = localUid;
    this.deviceId = deviceId;
    this.setupHandlers();
    this.setupPeerConnectionHandlers();
  }

  private setupHandlers(): void {
    this.channelBus.subscribe('media', async (envelope) => {
      await this.handleMediaMessage(envelope);
    });
  }

  private setupPeerConnectionHandlers(): void {
    this.peerConnection.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        this.notifyStreamListeners(this.remoteStream);
      }
    };

    this.peerConnection.onnegotiationneeded = async () => {
      // 重新協商時透過 signaling 完成
      await this.sendMediaState();
    };
  }

  async startLocalMedia(options: MediaOptions): Promise<MediaStream> {
    // 先取得 stream，再嘗試 addTrack；若 addTrack 失敗則 stop tracks 避免 camera LED 常亮
    const stream = await navigator.mediaDevices.getUserMedia(options);

    try {
      stream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, stream);
      });
    } catch (error) {
      // addTrack 失敗 → 釋放所有 tracks，避免資源洩漏
      stream.getTracks().forEach(t => t.stop());
      console.error('Error adding tracks to peer connection:', error);
      throw error;
    }

    this.localStream = stream;
    this.mediaState.audioEnabled = options.audio;
    this.mediaState.videoEnabled = !!options.video;
    this.notifyStateListeners();

    // 通知遠端媒體已準備
    await this.sendMediaReady();

    return this.localStream;
  }

  stopLocalMedia(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        track.stop();
        const sender = this.peerConnection.getSenders().find(s => s.track === track);
        if (sender) {
          this.peerConnection.removeTrack(sender);
        }
      });
      this.localStream = null;
    }

    this.mediaState.audioEnabled = false;
    this.mediaState.videoEnabled = false;
    this.notifyStateListeners();
  }

  toggleAudio(): void {
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        this.mediaState.audioMuted = !audioTrack.enabled;
        this.notifyStateListeners();
        this.sendMediaState();
      }
    }
  }

  toggleVideo(): void {
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        this.mediaState.videoMuted = !videoTrack.enabled;
        this.notifyStateListeners();
        this.sendMediaState();
      }
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  getMediaState(): MediaState {
    return { ...this.mediaState };
  }

  onStateChange(listener: (state: MediaState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onRemoteStreamChange(listener: (stream: MediaStream | null) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  private async handleMediaMessage(envelope: P2PEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'MEDIA_READY':
        // 遠端媒體已準備，可以開始顯示
        break;
      case 'MEDIA_TOGGLE': {
        // 遠端媒體狀態變更
        const { audioMuted, videoMuted } = envelope.payload as Partial<MediaState>;
        if (audioMuted !== undefined) {
          this.mediaState.audioMuted = audioMuted;
        }
        if (videoMuted !== undefined) {
          this.mediaState.videoMuted = videoMuted;
        }
        this.notifyStateListeners();
        break;
      }
      case 'MEDIA_END':
        // 遠端結束媒體
        this.remoteStream = null;
        this.notifyStreamListeners(null);
        break;
    }
  }

  private async sendMediaReady(): Promise<void> {
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'media',
      type: 'MEDIA_READY',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: {
        audioEnabled: this.mediaState.audioEnabled,
        videoEnabled: this.mediaState.videoEnabled,
      },
    };

    await this.channelBus.send(envelope);
  }

  private async sendMediaState(): Promise<void> {
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'media',
      type: 'MEDIA_TOGGLE',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: {
        audioMuted: this.mediaState.audioMuted,
        videoMuted: this.mediaState.videoMuted,
      },
    };

    await this.channelBus.send(envelope);
  }

  private notifyStateListeners(): void {
    this.stateListeners.forEach(listener => listener({ ...this.mediaState }));
  }

  private notifyStreamListeners(stream: MediaStream | null): void {
    this.streamListeners.forEach(listener => listener(stream));
  }
}



