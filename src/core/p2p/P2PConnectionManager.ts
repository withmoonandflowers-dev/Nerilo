import {
  ref,
  push,
  set,
  get,
  remove,
  onChildAdded,
  query as rtdbQuery,
  orderByChild,
  startAt,
  onDisconnect,
} from 'firebase/database';
import { rtdb } from '../../config/firebase';
import { RTDB } from '../../config/rtdb-paths';
import { logger } from '../../utils/logger';
import type { ConnectionState, Signal } from '../../types';
import { getIceServerProvider } from './IceServerProvider';

export interface IceServers {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Auto-reconnect configuration */
export interface ReconnectConfig {
  /** Maximum number of reconnect attempts (default: 5) */
  maxAttempts: number;
  /** Initial delay in ms before first retry (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in ms (caps exponential growth, default: 30000) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
};

export class P2PConnectionManager {
  private pc: RTCPeerConnection | null = null;
  private roomId: string;
  private localUid: string;
  private remoteUid: string | null = null;
  private state: ConnectionState = 'idle';
  private stateListeners: Set<(state: ConnectionState) => void> = new Set();
  private iceServers: RTCConfiguration['iceServers'] = [];
  private signalUnsubscribers: (() => void)[] = [];
  /** ICE candidates that arrived before remoteDescription was set; flushed after setRemoteDescription */
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  /** 已處理的 signal ID 集合，防止快照重播導致重複處理 */
  private processedSignalIds: Set<string> = new Set();
  /** Signal 處理互斥鎖：確保 handleSignal 不會並行執行（避免 signalingState 競態） */
  private signalMutex: Promise<void> = Promise.resolve();
  /** 此連線的建立時間戳（epoch ms），用來過濾掉舊 session 殘留的 signals */
  private sessionStartedAt: number = Date.now();
  /** 是否已清理舊 signals（只在首次連線成功時執行一次） */
  private hasCleanedOldSignals = false;
  /**
   * Signal 通道標籤：用於隔離同一房間內不同連線的 signals。
   * - Star: 'chat'
   * - Mesh neighbor: 'mesh-{remoteFirebaseUid}'
   * 寫入 signal 文件，收到時只處理匹配的 channelLabel。
   */
  private readonly channelLabel: string;

  // ── Auto-Reconnect State ────────────────────────────────────────────────
  private readonly reconnectConfig: ReconnectConfig;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether this peer is the initiator (creates offer). Set by P2PManager. */
  private isInitiator = false;
  /** Callback invoked when reconnection succeeds */
  private reconnectListeners: Set<(attempt: number) => void> = new Set();
  /** Whether the manager has been explicitly closed (prevents reconnect after close) */
  private isClosed = false;

  constructor(roomId: string, localUid: string, channelLabel = 'default', reconnectConfig?: Partial<ReconnectConfig>) {
    this.roomId = roomId;
    this.localUid = localUid;
    this.channelLabel = channelLabel;
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...reconnectConfig };
  }

  async initialize(): Promise<void> {
    try {
      logger.info('[P2PConnectionManager] initialize called', {
        roomId: this.roomId,
        localUid: this.localUid,
      });

      // 清理上一次的 RTCPeerConnection（防止資源洩漏）
      if (this.pc) {
        logger.warn('[P2PConnectionManager] Closing stale RTCPeerConnection before re-init', {
          roomId: this.roomId,
        });
        this.pc.close();
        this.pc = null;
      }

      // 取得 ICE servers（可選：從 Cloud Functions）
      this.iceServers = await this.getIceServers();
      logger.info('[P2PConnectionManager] ICE servers obtained', {
        roomId: this.roomId,
        serverCount: this.iceServers?.length || 0,
      });

      // 建立 RTCPeerConnection
      this.pc = new RTCPeerConnection({
        iceServers: this.iceServers,
      });

      logger.info('[P2PConnectionManager] RTCPeerConnection created', {
        roomId: this.roomId,
        connectionState: this.pc?.connectionState,
        signalingState: this.pc?.signalingState,
      });

      this.setupPeerConnectionHandlers();
      this.setupSignalingListeners();

      this.setState('connecting');
      logger.info('[P2PConnectionManager] initialize completed', {
        roomId: this.roomId,
        state: this.state,
      });
    } catch (error) {
      logger.error('[P2PConnectionManager] initialize error', {
        roomId: this.roomId,
        localUid: this.localUid,
        error,
      });
      this.setState('failed');
      throw error;
    }
  }

  private async getIceServers(): Promise<RTCConfiguration['iceServers']> {
    try {
      const provider = getIceServerProvider();
      return await provider.getIceServers();
    } catch (err) {
      logger.warn('[P2PConnectionManager] IceServerProvider failed, using default STUN', err);
      return [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ];
    }
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.pc) return;

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal('ice', event.candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;

      const state = this.pc.connectionState;
      switch (state) {
        case 'connected':
          if (this.reconnectAttempt > 0) {
            logger.info('[P2PConnectionManager] Reconnected successfully', {
              roomId: this.roomId,
              attempt: this.reconnectAttempt,
            });
            this.notifyReconnectListeners(this.reconnectAttempt);
          }
          this.reconnectAttempt = 0;
          this.cancelReconnectTimer();
          this.setState('connected');
          this.cleanupOldSignals();
          break;
        case 'disconnected':
          logger.info('[P2PConnectionManager] Connection disconnected (transient)', {
            roomId: this.roomId,
          });
          break;
        case 'failed':
          this.handleConnectionFailure();
          break;
        case 'closed':
          this.setState('closed');
          break;
        default:
          break;
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      logger.info('ICE connection state:', this.pc.iceConnectionState);
    };
  }

  private setupSignalingListeners(): void {
    // 清除既有 listeners，避免 reconnect 時累積
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];

    logger.info('[P2PConnectionManager] setupSignalingListeners', { roomId: this.roomId });

    const signalsRef = ref(rtdb, RTDB.signals(this.roomId));
    // 只訂閱「本次 session 之後」建立的 signals，忽略舊 session 殘留。
    // 使用 orderByChild('createdAt') + startAt(sessionStartedAt) 過濾。
    const q = rtdbQuery(
      signalsRef,
      orderByChild('createdAt'),
      startAt(this.sessionStartedAt),
    );

    const unsubscribe = onChildAdded(q, (snapshot) => {
      const signalId = snapshot.key;
      if (!signalId) return;

      const data = snapshot.val();
      if (!data) return;

      const signal = { ...data, signalId } as Signal;

      // 去重：RTDB onChildAdded 在重連時可能重播已處理的 signals
      if (this.processedSignalIds.has(signalId)) {
        return;
      }
      this.processedSignalIds.add(signalId);

      logger.info('[P2PConnectionManager] Processing signal', {
        roomId: this.roomId,
        signalId,
        type: signal.type,
        from: signal.from,
      });

      // 串行化：每個 signal 必須等前一個完成後才處理
      this.signalMutex = this.signalMutex
        .then(() => this.handleSignal(signal))
        .catch((err) => {
          logger.error('[P2PConnectionManager] Signal mutex error', {
            roomId: this.roomId,
            signalId,
            err,
          });
        });
    });

    this.signalUnsubscribers.push(unsubscribe);
    logger.info('[P2PConnectionManager] Signaling listener setup completed', { roomId: this.roomId });
  }

  private async handleSignal(signal: Signal): Promise<void> {
    if (!this.pc) {
      logger.warn('[P2PConnectionManager] handleSignal: PeerConnection not available', {
        roomId: this.roomId,
        signalType: signal.type,
        from: signal.from,
      });
      return;
    }

    // 過濾不屬於此 channelLabel 的 signal（Star 和 Mesh 隔離）
    const signalLabel = (signal as unknown as Record<string, unknown>).channelLabel as string | undefined;
    if (signalLabel && signalLabel !== this.channelLabel) {
      return;
    }

    // 過濾不屬於自己的 signal（多人房間中，signal.to 可指定接收者）
    if (signal.to && signal.to !== this.localUid) {
      return;
    }

    if (signal.from === this.localUid) {
      logger.debug('[P2PConnectionManager] handleSignal: Ignoring signal from self', {
        roomId: this.roomId,
        signalType: signal.type,
      });
      return;
    }

    this.remoteUid = signal.from;

    logger.info('[P2PConnectionManager] handleSignal', {
      roomId: this.roomId,
      signalType: signal.type,
      from: signal.from,
      signalingState: this.pc.signalingState,
      hasLocalDescription: !!this.pc.localDescription,
      hasRemoteDescription: !!this.pc.remoteDescription,
    });

    try {
      switch (signal.type) {
        case 'offer': {
          if (this.pc.signalingState !== 'stable') {
            logger.debug('[P2PConnectionManager] Ignore offer in state', this.pc.signalingState);
            return;
          }
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit));
          await this.flushPendingIceCandidates();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.sendSignal('answer', answer);
          break;
        }

        case 'answer': {
          if (this.pc.remoteDescription) {
            logger.debug('[P2PConnectionManager] Ignore duplicate answer');
            return;
          }
          if (this.pc.signalingState !== 'have-local-offer') {
            logger.debug('[P2PConnectionManager] Ignore answer in state', this.pc.signalingState, '- expected have-local-offer');
            return;
          }
          if (!this.pc.localDescription) {
            logger.debug('[P2PConnectionManager] Ignore answer - no local description set');
            return;
          }
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit));
          await this.flushPendingIceCandidates();
          break;
        }

        case 'ice': {
          const icePayload = signal.payload as RTCIceCandidateInit;
          const candidate: RTCIceCandidateInit = {
            candidate: icePayload.candidate,
            sdpMid: icePayload.sdpMid,
            sdpMLineIndex: icePayload.sdpMLineIndex,
          };
          if (!this.pc.remoteDescription) {
            logger.debug('[P2PConnectionManager] Buffering ICE candidate (remoteDescription not set yet)', {
              buffered: this.pendingIceCandidates.length + 1,
            });
            this.pendingIceCandidates.push(candidate);
            return;
          }
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          break;
        }
      }
    } catch (error) {
      logger.error('Error handling signal:', error);
    }
  }

  /** Apply all buffered ICE candidates that arrived before remoteDescription was set. */
  private async flushPendingIceCandidates(): Promise<void> {
    if (this.pendingIceCandidates.length === 0) return;
    logger.info('[P2PConnectionManager] Flushing buffered ICE candidates', {
      roomId: this.roomId,
      count: this.pendingIceCandidates.length,
    });
    const toFlush = this.pendingIceCandidates.splice(0);
    for (const candidate of toFlush) {
      try {
        await this.pc!.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        logger.warn('[P2PConnectionManager] Failed to add buffered ICE candidate', err);
      }
    }
  }

  async createOffer(): Promise<void> {
    if (!this.pc) throw new Error('PeerConnection not initialized');

    logger.info('[P2PConnectionManager] createOffer called', {
      roomId: this.roomId,
      localUid: this.localUid,
      signalingState: this.pc.signalingState,
    });

    try {
      const offer = await this.pc.createOffer();
      logger.info('[P2PConnectionManager] Offer created', {
        roomId: this.roomId,
        offerType: offer.type,
        sdpLength: offer.sdp?.length || 0,
      });

      await this.pc.setLocalDescription(offer);
      logger.info('[P2PConnectionManager] Local description set', {
        roomId: this.roomId,
        signalingState: this.pc.signalingState,
      });

      await this.sendSignal('offer', offer);
      logger.info('[P2PConnectionManager] Offer signal sent', { roomId: this.roomId });
    } catch (error) {
      logger.error('[P2PConnectionManager] Error creating offer', {
        roomId: this.roomId,
        error,
      });
      throw error;
    }
  }

  private async sendSignal(type: 'offer' | 'answer' | 'ice', payload: RTCSessionDescriptionInit | RTCIceCandidate): Promise<void> {
    const signalsRef = ref(rtdb, RTDB.signals(this.roomId));
    let serializedPayload: Record<string, unknown> = {};

    if (type === 'offer' || type === 'answer') {
      const sdpPayload = payload as RTCSessionDescriptionInit;
      serializedPayload = {
        type: sdpPayload.type,
        sdp: sdpPayload.sdp,
      };
    } else if (type === 'ice' && payload) {
      const icePayload = payload as RTCIceCandidate;
      serializedPayload = {
        candidate: icePayload.candidate,
        sdpMid: icePayload.sdpMid,
        sdpMLineIndex: icePayload.sdpMLineIndex,
      };
    }

    logger.info('[P2PConnectionManager] sendSignal', {
      roomId: this.roomId,
      from: this.localUid,
      to: this.remoteUid,
      type,
    });

    const newSignalRef = push(signalsRef);
    await set(newSignalRef, {
      from: this.localUid,
      to: this.remoteUid || null,
      type,
      payload: serializedPayload,
      createdAt: Date.now(),
      channelLabel: this.channelLabel,
    });

    // 設定 onDisconnect 自動清理：瀏覽器關閉時自動刪除此 signal
    onDisconnect(newSignalRef).remove();
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.stateListeners.forEach(listener => listener(newState));
  }

  /**
   * 清理 RTDB 中此房間的舊 signals（本次 session 之前的）
   * 在 P2P 連線成功（ICE connected）後呼叫一次。
   */
  private async cleanupOldSignals(): Promise<void> {
    if (this.hasCleanedOldSignals) return;
    this.hasCleanedOldSignals = true;

    try {
      const signalsRef = ref(rtdb, RTDB.signals(this.roomId));
      const snapshot = await get(signalsRef);
      if (!snapshot.exists()) return;

      const deletions: Promise<void>[] = [];
      snapshot.forEach((child) => {
        const data = child.val();
        if (data?.createdAt && data.createdAt < this.sessionStartedAt) {
          deletions.push(remove(child.ref));
        }
      });

      await Promise.allSettled(deletions);

      logger.info('[P2PConnectionManager] Cleaned up old signals', {
        roomId: this.roomId,
        deletedCount: deletions.length,
      });
    } catch (err) {
      logger.warn('[P2PConnectionManager] Failed to cleanup old signals', err);
    }
  }

  /**
   * 清理此連線本次 session 產生的 signals（離開房間時呼叫）
   */
  private async cleanupSessionSignals(): Promise<void> {
    try {
      const signalsRef = ref(rtdb, RTDB.signals(this.roomId));
      const snapshot = await get(signalsRef);
      if (!snapshot.exists()) return;

      const deletions: Promise<void>[] = [];
      snapshot.forEach((child) => {
        const data = child.val();
        if (data?.from === this.localUid) {
          deletions.push(remove(child.ref));
        }
      });

      await Promise.allSettled(deletions);

      logger.info('[P2PConnectionManager] Cleaned up session signals on close', {
        roomId: this.roomId,
        deletedCount: deletions.length,
      });
    } catch (err) {
      logger.warn('[P2PConnectionManager] Failed to cleanup session signals', err);
    }
  }

  // ── Auto-Reconnect ────────────────────────────────────────────────────

  /** Set the initiator role (needed to know whether to create offer on reconnect) */
  setInitiator(isInitiator: boolean): void {
    this.isInitiator = isInitiator;
  }

  /** Listen for successful reconnection events */
  onReconnect(listener: (attempt: number) => void): () => void {
    this.reconnectListeners.add(listener);
    return () => { this.reconnectListeners.delete(listener); };
  }

  /** Get current reconnect attempt number (0 = not reconnecting) */
  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  private handleConnectionFailure(): void {
    if (this.isClosed) {
      this.setState('failed');
      return;
    }

    const { maxAttempts } = this.reconnectConfig;
    if (this.reconnectAttempt >= maxAttempts) {
      logger.warn('[P2PConnectionManager] Max reconnect attempts reached, giving up', {
        roomId: this.roomId,
        attempts: this.reconnectAttempt,
      });
      this.reconnectAttempt = 0;
      this.setState('failed');
      return;
    }

    this.reconnectAttempt++;
    const delay = this.getReconnectDelay(this.reconnectAttempt);

    const useIceRestart = this.reconnectAttempt <= Math.ceil(maxAttempts / 2) && this.pc !== null;
    const strategy = useIceRestart ? 'ice-restart' : 'full-reconnect';

    logger.info('[P2PConnectionManager] Scheduling reconnect', {
      roomId: this.roomId,
      attempt: this.reconnectAttempt,
      strategy,
      delayMs: delay,
    });

    this.setState('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const attempt = useIceRestart
        ? this.attemptIceRestart()
        : this.attemptFullReconnect();
      attempt.catch((err) => {
        logger.error('[P2PConnectionManager] Reconnect attempt failed', {
          roomId: this.roomId,
          attempt: this.reconnectAttempt,
          strategy,
          err,
        });
      });
    }, delay);
  }

  private getReconnectDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, backoffMultiplier } = this.reconnectConfig;
    const exponential = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
    const capped = Math.min(exponential, maxDelayMs);
    return Math.round(Math.random() * capped);
  }

  private async attemptIceRestart(): Promise<void> {
    if (!this.pc) {
      return this.attemptFullReconnect();
    }

    logger.info('[P2PConnectionManager] Attempting ICE restart', {
      roomId: this.roomId,
      attempt: this.reconnectAttempt,
    });

    try {
      this.pc.restartIce();
      if (this.isInitiator) {
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        await this.sendSignal('offer', offer);
      }
    } catch (err) {
      logger.warn('[P2PConnectionManager] ICE restart failed, falling back to full reconnect', {
        roomId: this.roomId,
        err,
      });
      return this.attemptFullReconnect();
    }
  }

  private async attemptFullReconnect(): Promise<void> {
    logger.info('[P2PConnectionManager] Attempting full reconnect', {
      roomId: this.roomId,
      attempt: this.reconnectAttempt,
    });

    // Tear down old connection
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];
    this.pendingIceCandidates = [];
    this.processedSignalIds.clear();
    this.signalMutex = Promise.resolve();

    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    // Fresh session timestamp for signal isolation
    this.sessionStartedAt = Date.now();
    this.hasCleanedOldSignals = false;

    // Re-initialize
    this.iceServers = await this.getIceServers();
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.setupPeerConnectionHandlers();
    this.setupSignalingListeners();

    if (this.isInitiator) {
      await this.createOffer();
    }
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private notifyReconnectListeners(attempt: number): void {
    for (const listener of this.reconnectListeners) {
      try { listener(attempt); } catch { /* ignore */ }
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.cancelReconnectTimer();
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];
    this.pendingIceCandidates = [];
    this.processedSignalIds.clear();
    this.signalMutex = Promise.resolve();

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // 離開時清理自己在 RTDB 留下的 signals（非阻塞，best-effort）
    this.cleanupSessionSignals().catch(() => {});

    this.reconnectListeners.clear();
    this.setState('closed');
  }
}
