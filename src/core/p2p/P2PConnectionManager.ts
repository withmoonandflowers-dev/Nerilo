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
import type { ConnectionState, Signal } from '../../types';
import { getIceServerProvider } from './IceServerProvider';

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
      console.log('[P2PConnectionManager] initialize called', {
        roomId: this.roomId,
        localUid: this.localUid,
      });

      // 清理上一次的 RTCPeerConnection（防止資源洩漏）
      if (this.pc) {
        console.warn('[P2PConnectionManager] Closing stale RTCPeerConnection before re-init', {
          roomId: this.roomId,
        });
        this.pc.close();
        this.pc = null;
      }

      // 取得 ICE servers（可選：從 Cloud Functions）
      this.iceServers = await this.getIceServers();
      console.log('[P2PConnectionManager] ICE servers obtained', {
        roomId: this.roomId,
        serverCount: this.iceServers?.length || 0,
      });

      // 建立 RTCPeerConnection
      this.pc = new RTCPeerConnection({
        iceServers: this.iceServers,
      });

      console.log('[P2PConnectionManager] RTCPeerConnection created', {
        roomId: this.roomId,
        connectionState: this.pc?.connectionState,
        signalingState: this.pc?.signalingState,
      });

      this.setupPeerConnectionHandlers();
      this.setupSignalingListeners();
      
      this.setState('connecting');
      console.log('[P2PConnectionManager] initialize completed', {
        roomId: this.roomId,
        state: this.state,
      });
    } catch (error) {
      console.error('[P2PConnectionManager] initialize error', {
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
      console.warn('[P2PConnectionManager] IceServerProvider failed, using default STUN', err);
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
          this.setState('connected');
          // 連線成功後清理舊 session 的 signals（非阻塞）
          this.cleanupOldSignals();
          break;
        case 'disconnected':
          // 'disconnected' 是暫時性狀態，瀏覽器會嘗試自動恢復；
          // 不立即標記為 failed，留給上層偵測逾時後處理。
          break;
        case 'failed':
          this.setState('failed');
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
      console.log('ICE connection state:', this.pc.iceConnectionState);
    };
  }

  private setupSignalingListeners(): void {
    // 清除既有 listeners，避免 reconnect 時累積 (#9)
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];

    console.log('[P2PConnectionManager] setupSignalingListeners', { roomId: this.roomId });

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
      console.log('[P2PConnectionManager] Signal snapshot received', {
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

          console.log('[P2PConnectionManager] Processing signal', {
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
              console.error('[P2PConnectionManager] Signal mutex error', {
                roomId: this.roomId,
                signalId: signal.signalId,
                err,
              });
            });
        }
      }
    });

    this.signalUnsubscribers.push(unsubscribe);
    console.log('[P2PConnectionManager] Signaling listener setup completed', { roomId: this.roomId });
  }

  private async handleSignal(signal: Signal): Promise<void> {
    if (!this.pc) {
      console.warn('[P2PConnectionManager] handleSignal: PeerConnection not available', {
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
      console.debug('[P2PConnectionManager] handleSignal: Ignoring signal from self', {
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

    console.log('[P2PConnectionManager] handleSignal', {
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
            console.debug(
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
            console.debug('[P2PConnectionManager] Ignore duplicate answer');
            return;
          }
          // 只有在 signalingState 為 'have-local-offer' 時才能設置 answer
          // 這表示已經設置了本地 offer，正在等待遠端的 answer
          if (this.pc.signalingState !== 'have-local-offer') {
            console.debug(
              '[P2PConnectionManager] Ignore answer in state',
              this.pc.signalingState,
              '- expected have-local-offer'
            );
            return;
          }
          // 確保已經設置了本地描述（offer）
          if (!this.pc.localDescription) {
            console.debug('[P2PConnectionManager] Ignore answer - no local description set');
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
            console.debug(
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
      console.error('Error handling signal:', error);
    }
  }

  /** Apply all buffered ICE candidates that arrived before remoteDescription was set. */
  private async flushPendingIceCandidates(): Promise<void> {
    if (this.pendingIceCandidates.length === 0) return;
    console.log('[P2PConnectionManager] Flushing buffered ICE candidates', {
      roomId: this.roomId,
      count: this.pendingIceCandidates.length,
    });
    const toFlush = this.pendingIceCandidates.splice(0);
    for (const candidate of toFlush) {
      try {
        await this.pc!.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[P2PConnectionManager] Failed to add buffered ICE candidate', err);
      }
    }
  }

  async createOffer(): Promise<void> {
    if (!this.pc) throw new Error('PeerConnection not initialized');

    console.log('[P2PConnectionManager] createOffer called', {
      roomId: this.roomId,
      localUid: this.localUid,
      signalingState: this.pc.signalingState,
    });

    try {
      const offer = await this.pc.createOffer();
      console.log('[P2PConnectionManager] Offer created', {
        roomId: this.roomId,
        offerType: offer.type,
        sdpLength: offer.sdp?.length || 0,
      });
      
      await this.pc.setLocalDescription(offer);
      console.log('[P2PConnectionManager] Local description set', {
        roomId: this.roomId,
        signalingState: this.pc.signalingState,
      });
      
      await this.sendSignal('offer', offer);
      console.log('[P2PConnectionManager] Offer signal sent', { roomId: this.roomId });
    } catch (error) {
      console.error('[P2PConnectionManager] Error creating offer', {
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

    console.log('[P2PConnectionManager] sendSignal', {
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
    this.state = newState;
    this.stateListeners.forEach(listener => listener(newState));
  }

  /**
   * 清理 Firestore 中此房間的舊 signals（本次 session 之前的）
   * 在 P2P 連線成功（ICE connected）後呼叫一次。
   * 設計原則：signal 僅用於建立連線，連線建立後即無用途，不需保留。
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

      const deletions = snapshot.docs.map(d => deleteDoc(d.ref));
      await Promise.allSettled(deletions);

      console.log('[P2PConnectionManager] Cleaned up old signals', {
        roomId: this.roomId,
        deletedCount: snapshot.size,
      });
    } catch (err) {
      // 清理失敗不影響功能，只記 log
      console.warn('[P2PConnectionManager] Failed to cleanup old signals', err);
    }
  }

  /**
   * 清理此連線本次 session 產生的 signals（離開房間時呼叫）
   * 確保離開後不留下任何 signaling 資料。
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

      const deletions = snapshot.docs.map(d => deleteDoc(d.ref));
      await Promise.allSettled(deletions);

      console.log('[P2PConnectionManager] Cleaned up session signals on close', {
        roomId: this.roomId,
        deletedCount: snapshot.size,
      });
    } catch (err) {
      console.warn('[P2PConnectionManager] Failed to cleanup session signals', err);
    }
  }

  async close(): Promise<void> {
    // 先取消 Firestore 訂閱，避免 close 過程中收到新 signals
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];
    this.pendingIceCandidates = [];
    this.processedSignalIds.clear();
    this.signalMutex = Promise.resolve();

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // 離開時清理自己在 Firestore 留下的 signals（非阻塞，best-effort）
    this.cleanupSessionSignals().catch(() => {});

    this.setState('closed');
  }
}

