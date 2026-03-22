import { 
  collection, 
  onSnapshot, 
  addDoc, 
  query, 
  orderBy,
  limit,
  Timestamp 
} from 'firebase/firestore';
import { db } from '../../config/firebase';
import type { ConnectionState, Signal } from '../../types';

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

  constructor(roomId: string, localUid: string) {
    this.roomId = roomId;
    this.localUid = localUid;
  }

  async initialize(): Promise<void> {
    try {
      console.log('[P2PConnectionManager] initialize called', {
        roomId: this.roomId,
        localUid: this.localUid,
      });

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
    const defaultServers: RTCConfiguration['iceServers'] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // 開發 / 個人專案階段：直接使用公開 STUN，不呼叫 Cloud Functions。
    // 這樣可以避免：
    // - 本機 CORS 問題
    // - 專案尚未升級到 Blaze 導致的 Functions 失敗
    // 未來若要整合 Twilio TURN，再改回呼叫 Cloud Functions 即可。
    return defaultServers;
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
    console.log('[P2PConnectionManager] setupSignalingListeners', { roomId: this.roomId });
    
    const signalsRef = collection(db, 'p2pRooms', this.roomId, 'signals');
    // 只依照建立時間排序取得最近的訊號，實際過濾「自己送出的訊號」
    // 交給 handleSignal 裡的 `if (signal.from === this.localUid) return;` 處理，
    // 這樣可以避免使用 `where('!=')` 帶來的複合索引需求。
    const q = query(signalsRef, orderBy('createdAt', 'desc'), limit(50));

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      console.log('[P2PConnectionManager] Signal snapshot received', {
        roomId: this.roomId,
        changeCount: snapshot.docChanges().length,
      });

      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const signal = { ...change.doc.data(), signalId: change.doc.id } as Signal;
          console.log('[P2PConnectionManager] Processing signal', {
            roomId: this.roomId,
            signalId: signal.signalId,
            type: signal.type,
            from: signal.from,
          });
          await this.handleSignal(signal);
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
    
    if (signal.from === this.localUid) {
      console.debug('[P2PConnectionManager] handleSignal: Ignoring signal from self', {
        roomId: this.roomId,
        signalType: signal.type,
      });
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
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
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
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
          break;
        }

        case 'ice': {
          // 只有在已經有 remoteDescription 時才加入 ICE，否則會觸發 InvalidStateError
          if (!this.pc.remoteDescription) {
            console.debug(
              '[P2PConnectionManager] Skip ICE candidate because remoteDescription is null'
            );
            return;
          }
          await this.pc.addIceCandidate(
            new RTCIceCandidate({
              candidate: signal.payload.candidate,
              sdpMid: signal.payload.sdpMid,
              sdpMLineIndex: signal.payload.sdpMLineIndex,
            })
          );
          break;
        }
      }
    } catch (error) {
      console.error('Error handling signal:', error);
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

  private async sendSignal(type: 'offer' | 'answer' | 'ice', payload: any): Promise<void> {
    const signalsRef = collection(db, 'p2pRooms', this.roomId, 'signals');
    // Firestore 只接受可序列化的 JSON 資料，因此需要將 RTCSessionDescription / RTCIceCandidate 序列化
    let serializedPayload: any = payload;

    if (type === 'offer' || type === 'answer') {
      serializedPayload = {
        type: payload.type,
        sdp: payload.sdp,
      };
    } else if (type === 'ice' && payload) {
      serializedPayload = {
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
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

  async close(): Promise<void> {
    this.signalUnsubscribers.forEach(unsub => unsub());
    this.signalUnsubscribers = [];

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    this.setState('closed');
  }
}

