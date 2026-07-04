import {
  collection,
  onSnapshot,
  addDoc,
  query,
  orderBy,
  where,
  limit,
  Timestamp,
  getDocs,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import { logger } from '../../utils/logger';
import type { ConnectionState, Signal } from '../../types';
import { getIceServerProvider } from './IceServerProvider';
import { connectionStats } from '../metrics/ConnectionStats';
import { connectionDiagnostics } from '../metrics/ConnectionDiagnostics';

export interface IceServers {
  urls: string | string[];
  username?: string;
  credential?: string;
}

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
  /** 已處理的 signal ID 集合，防止 Firestore 快照重播導致重複處理 */
  private processedSignalIds: Set<string> = new Set();
  /** Signal 處理互斥鎖：確保 handleSignal 不會並行執行（避免 signalingState 競態） */
  private signalMutex: Promise<void> = Promise.resolve();
  /** 此連線的建立時間戳，用來過濾掉舊 session 殘留的 signals */
  private readonly sessionStartedAt: Timestamp = Timestamp.now();
  /** 是否已清理舊 signals（只在首次連線成功時執行一次） */
  private hasCleanedOldSignals = false;
  /** 本次 session 是否已嘗試過 ICE restart（一次重試，ADR-0019） */
  private iceRestartAttempted = false;
  /** restart 後首次恢復的 one-shot 標記（統計用，避免後續 connected 重複計） */
  private pendingRestartRecovery = false;
  /** 是否曾以發起方身分 createOffer（restart 時由發起方重新 offer） */
  private hasCreatedOffer = false;
  /** ICE restart 後的恢復逾時計時器 */
  private iceRestartTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /**
   * Signal 通道標籤：用於隔離同一房間內不同連線的 signals。
   * - Star: 'chat'
   * - Mesh neighbor: 'mesh-{remoteFirebaseUid}'
   * 寫入 Firestore signal 文件，收到時只處理匹配的 channelLabel。
   */
  private readonly channelLabel: string;

  constructor(roomId: string, localUid: string, channelLabel = 'default') {
    this.roomId = roomId;
    this.localUid = localUid;
    this.channelLabel = channelLabel;
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
      connectionStats.recordAttempt();
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
    // 使用 IceServerProvider 統一管理 STUN/TURN 配置
    // 支援靜態配置（環境變數）和動態取得（Cloud Function）
    // 設定方式：
    //   VITE_TURN_URLS=turn:your-server.com:3478 （靜態 TURN）
    //   VITE_TURN_USERNAME=user
    //   VITE_TURN_CREDENTIAL=pass
    //   VITE_TURN_CREDENTIAL_ENDPOINT=https://... （動態 TURN）
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
          // ICE restart 成功恢復 → 取消逾時定案
          if (this.iceRestartTimeoutId !== null) {
            clearTimeout(this.iceRestartTimeoutId);
            this.iceRestartTimeoutId = null;
          }
          connectionStats.recordConnected();
          if (this.pendingRestartRecovery) {
            this.pendingRestartRecovery = false; // one-shot：只計 restart 後首次恢復
            connectionStats.recordIceRestartRecovered();
          }
          this.setState('connected');
          // 連線成功後清理舊 session 的 signals（非阻塞）
          this.cleanupOldSignals();
          break;
        case 'disconnected':
          // 'disconnected' 是暫時性狀態，瀏覽器會嘗試自動恢復；
          // 不立即標記為 failed，留給上層偵測逾時後處理。
          break;
        case 'failed':
          // ADR-0019：先嘗試一次 ICE restart（換網路/NAT rebind 常見可救），
          // 已試過或 restart 後仍 failed 才定案。
          if (!this.iceRestartAttempted) {
            this.attemptIceRestart();
          } else {
            connectionStats.recordFailed();
            this.setState('failed');
          }
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

  /**
   * ICE restart 一次重試（ADR-0019）。
   * 發起方：restartIce() 產生新 ICE credentials 後重新 createOffer 走既有 signaling；
   * 應答方：保持 connecting，等發起方的新 offer（既有 signal listener 會接手）。
   * 15 秒內未恢復 connected 即定案 failed（UI 狀態列據 state 呈現重連中/失敗）。
   */
  private attemptIceRestart(): void {
    if (!this.pc) return;
    this.iceRestartAttempted = true;
    this.pendingRestartRecovery = true;
    connectionStats.recordIceRestart();
    connectionDiagnostics.record('ice-restart', {
      roomId: this.roomId,
      wasInitiator: this.hasCreatedOffer,
    });
    this.setState('connecting');

    logger.warn('[P2PConnectionManager] Connection failed — attempting one ICE restart', {
      roomId: this.roomId,
      wasInitiator: this.hasCreatedOffer,
    });

    try {
      this.pc.restartIce();
      if (this.hasCreatedOffer) {
        // 發起方重新 offer（restartIce 後 createOffer 會帶新 ICE credentials）
        this.createOffer().catch((err) => {
          logger.error('[P2PConnectionManager] ICE restart re-offer failed', { roomId: this.roomId, err });
          connectionStats.recordFailed();
          this.setState('failed');
        });
      }
    } catch (err) {
      logger.error('[P2PConnectionManager] restartIce threw', { roomId: this.roomId, err });
      connectionStats.recordFailed();
      this.setState('failed');
      return;
    }

    // 恢復逾時：15 秒內未回到 connected 即定案
    this.iceRestartTimeoutId = setTimeout(() => {
      this.iceRestartTimeoutId = null;
      if (this.pc && this.pc.connectionState !== 'connected') {
        logger.warn('[P2PConnectionManager] ICE restart did not recover in time', { roomId: this.roomId });
        connectionStats.recordFailed();
        this.setState('failed');
      }
    }, 15_000);
  }

  private setupSignalingListeners(): void {
    // 清除既有 listeners，避免 reconnect 時累積 (#9)
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];

    logger.info('[P2PConnectionManager] setupSignalingListeners', { roomId: this.roomId });

    const signalsRef = collection(db, 'p2pRooms', this.roomId, 'signals');
    // 只訂閱「本次 session 之後」建立的 signals，忽略舊 session 殘留。
    // 這是最關鍵的 signal 隔離：避免上一輪的 offer/answer 干擾新連線。
    // 使用 asc 排序確保因果順序：offer/answer 先到，ICE candidates 後到。
    const q = query(
      signalsRef,
      where('createdAt', '>=', this.sessionStartedAt),
      orderBy('createdAt', 'asc'),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      logger.info('[P2PConnectionManager] Signal snapshot received', {
        roomId: this.roomId,
        changeCount: snapshot.docChanges().length,
      });

      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const signal = { ...change.doc.data(), signalId: change.doc.id } as Signal;

          // 去重：Firestore onSnapshot 在重連時可能重播已處理的 signals
          if (this.processedSignalIds.has(signal.signalId)) {
            continue;
          }
          this.processedSignalIds.add(signal.signalId);

          logger.info('[P2PConnectionManager] Processing signal', {
            roomId: this.roomId,
            signalId: signal.signalId,
            type: signal.type,
            from: signal.from,
          });

          // 串行化：每個 signal 必須等前一個完成後才處理
          // 防止兩個 answer/offer 並行執行導致 signalingState 競態
          this.signalMutex = this.signalMutex
            .then(() => this.handleSignal(signal))
            .catch((err) => {
              logger.error('[P2PConnectionManager] Signal mutex error', {
                roomId: this.roomId,
                signalId: signal.signalId,
                err,
              });
            });
        }
      }
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
    // 向後相容：channelLabel 為 undefined 的舊 signals 不過濾
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

    // 3+ 人房間：signal.to 存在時，只處理「寄給我的」信號
    if (signal.to && signal.to !== this.localUid) {
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
          // 只有在 signalingState 為 'stable' 時才接受新的 offer，避免重複協商產生錯誤
          if (this.pc.signalingState !== 'stable') {
            logger.debug(
              '[P2PConnectionManager] Ignore offer in state',
              this.pc.signalingState
            );
            return;
          }
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit));
          // Flush ICE candidates that arrived before the offer (Firestore desc-order issue)
          await this.flushPendingIceCandidates();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.sendSignal('answer', answer);
          break;
        }

        case 'answer': {
          // 若已經有 remoteDescription，就忽略重複的 answer
          if (this.pc.remoteDescription) {
            logger.debug('[P2PConnectionManager] Ignore duplicate answer');
            return;
          }
          // 只有在 signalingState 為 'have-local-offer' 時才能設置 answer
          // 這表示已經設置了本地 offer，正在等待遠端的 answer
          if (this.pc.signalingState !== 'have-local-offer') {
            logger.debug(
              '[P2PConnectionManager] Ignore answer in state',
              this.pc.signalingState,
              '- expected have-local-offer'
            );
            return;
          }
          // 確保已經設置了本地描述（offer）
          if (!this.pc.localDescription) {
            logger.debug('[P2PConnectionManager] Ignore answer - no local description set');
            return;
          }
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit));
          // Flush ICE candidates that arrived before the answer (Firestore desc-order issue)
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
            // Buffer early ICE candidates; they will be flushed after setRemoteDescription.
            // This happens when Firestore returns signals newest-first (desc order),
            // causing ICE to arrive before the offer/answer is processed.
            logger.debug(
              '[P2PConnectionManager] Buffering ICE candidate (remoteDescription not set yet)',
              { buffered: this.pendingIceCandidates.length + 1 }
            );
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
    this.hasCreatedOffer = true; // 記住發起方身分，ICE restart 時由發起方重新 offer

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
    const signalsRef = collection(db, 'p2pRooms', this.roomId, 'signals');
    // Firestore 只接受可序列化的 JSON 資料，因此需要將 RTCSessionDescription / RTCIceCandidate 序列化
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

    await addDoc(signalsRef, {
      from: this.localUid,
      to: this.remoteUid || null,
      type,
      payload: serializedPayload,
      createdAt: Timestamp.now(),
      channelLabel: this.channelLabel,
    });
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
    // 診斷軌跡：記錄每次狀態轉換（含 ICE state），供除錯 dump / Sentry breadcrumb。
    // 一鉤捕獲整條生命週期。
    connectionDiagnostics.record(`state:${newState}`, {
      roomId: this.roomId,
      channel: this.channelLabel,
      from: this.state,
      iceState: this.pc?.iceConnectionState,
    });
    this.state = newState;
    this.stateListeners.forEach(listener => listener(newState));
  }

  /**
   * 清理 Firestore 中此房間的舊 signals（本次 session 之前的）
   * 在 P2P 連線成功（ICE connected）後呼叫一次。
   * 設計原則：signal 僅用於建立連線，連線建立後即無用途，不需保留。
   *
   * 只清「自己這條 channel」的：mesh 下同房有多條連線併發建立（A↔B、A↔C、B↔C
   * 各自的 P2PConnectionManager），無差別刪整房舊 signal 會把其他 pair 還在等的
   * offer/ICE 刪掉，造成該 pair 永久建不起來（隨機分割 mesh）。
   */
  private async cleanupOldSignals(): Promise<void> {
    if (this.hasCleanedOldSignals) return;
    this.hasCleanedOldSignals = true;

    try {
      const signalsRef = collection(db, 'p2pRooms', this.roomId, 'signals');
      // 刪除本次 session 之前的所有 signals
      const oldSignalsQuery = query(
        signalsRef,
        where('createdAt', '<', this.sessionStartedAt),
        limit(100)
      );
      const snapshot = await getDocs(oldSignalsQuery);
      if (snapshot.empty) return;

      // client-side 過濾 channelLabel（避免複合索引）；無 label 的舊格式文件
      // 可能屬於任何連線，一律不動
      const own = snapshot.docs.filter(
        d => (d.data() as Record<string, unknown>).channelLabel === this.channelLabel
      );
      if (own.length === 0) return;

      const deletions = own.map(d => deleteDoc(d.ref));
      await Promise.allSettled(deletions);

      logger.info('[P2PConnectionManager] Cleaned up old signals', {
        roomId: this.roomId,
        deletedCount: own.length,
      });
    } catch (err) {
      // 清理失敗不影響功能，只記 log
      logger.warn('[P2PConnectionManager] Failed to cleanup old signals', err);
    }
  }

  /**
   * 清理此連線本次 session 產生的 signals（離開房間時呼叫）
   * 確保離開後不留下任何 signaling 資料。
   *
   * 只清「自己這條 channel」的：同頁面可能同時有其他連線在建立
   * （最典型：star→mesh 遷移時 star close，會與剛寫出的 mesh offer 併發；
   * 只以 from 過濾會把自己 mesh 連線的 signaling 一起刪掉，該節點從此
   * 連不進 mesh、退化到 Firestore 備援）。
   */
  private async cleanupSessionSignals(): Promise<void> {
    try {
      const signalsRef = collection(db, 'p2pRooms', this.roomId, 'signals');
      const sessionSignalsQuery = query(
        signalsRef,
        where('from', '==', this.localUid),
        limit(100)
      );
      const snapshot = await getDocs(sessionSignalsQuery);
      if (snapshot.empty) return;

      // client-side 過濾 channelLabel（避免複合索引）；無 label 的舊格式不動
      const own = snapshot.docs.filter(
        d => (d.data() as Record<string, unknown>).channelLabel === this.channelLabel
      );
      if (own.length === 0) return;

      const deletions = own.map(d => deleteDoc(d.ref));
      await Promise.allSettled(deletions);

      logger.info('[P2PConnectionManager] Cleaned up session signals on close', {
        roomId: this.roomId,
        deletedCount: own.length,
      });
    } catch (err) {
      logger.warn('[P2PConnectionManager] Failed to cleanup session signals', err);
    }
  }

  async close(): Promise<void> {
    // 先取消 Firestore 訂閱，避免 close 過程中收到新 signals
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];
    this.pendingIceCandidates = [];
    this.processedSignalIds.clear();
    this.signalMutex = Promise.resolve();
    if (this.iceRestartTimeoutId !== null) {
      clearTimeout(this.iceRestartTimeoutId);
      this.iceRestartTimeoutId = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // 離開時清理自己在 Firestore 留下的 signals（非阻塞，best-effort）
    this.cleanupSessionSignals().catch(() => {});

    this.setState('closed');
  }
}

