/**
 * P2PConnectionManager unit tests
 *
 * 核心測試情境：
 * 1. ICE candidate buffer：ICE 比 offer/answer 先到時應先 buffer，等 setRemoteDescription 後 flush
 * 2. Signal 過濾：自己送出的訊號應忽略
 * 3. 重複 answer 忽略
 * 4. close() 清空 buffer
 * 5. onStateChange 回呼機制
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Signal } from '../../src/types';

// ── Firebase RTDB mock ───────────────────────────────────────────────────────
vi.mock('../../src/config/firebase', () => ({ rtdb: {} }));

vi.mock('../../src/config/rtdb-paths', () => ({
  RTDB: {
    signals: (roomId: string) => `signals/${roomId}`,
    signal: (roomId: string, id: string) => `signals/${roomId}/${id}`,
  }
}));

let capturedOnChildAddedCb: ((snapshot: any) => void) | null = null;

const mockRef = { key: 'mock-ref' };
const mockPushRef = { key: 'signal-push-id', ...mockRef };
const mockSet = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockOnDisconnectRemove = vi.fn();
const mockOnDisconnect = vi.fn().mockReturnValue({ remove: mockOnDisconnectRemove });
const mockPush = vi.fn().mockReturnValue(mockPushRef);

const mockOnChildAdded = vi.fn().mockImplementation((_q: unknown, cb: any) => {
  capturedOnChildAddedCb = cb;
  return vi.fn(); // unsubscribe
});

const mockGet = vi.fn().mockResolvedValue({
  exists: () => false,
  forEach: vi.fn(),
  val: () => null,
});

vi.mock('firebase/database', () => ({
  ref: vi.fn(() => mockRef),
  push: mockPush,
  set: mockSet,
  get: mockGet,
  remove: mockRemove,
  onChildAdded: mockOnChildAdded,
  query: vi.fn((_ref: unknown) => _ref),
  orderByChild: vi.fn(() => ({})),
  startAt: vi.fn(() => ({})),
  onDisconnect: mockOnDisconnect,
}));

// ── RTCPeerConnection mock ─────────────────────────────────────────────────────
class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceConnectionState: RTCIceConnectionState = 'new';

  onicecandidate: ((e: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' });

  setLocalDescription = vi.fn().mockImplementation(async (desc: any) => {
    this.localDescription = desc;
    if (desc.type === 'offer') this.signalingState = 'have-local-offer';
    else this.signalingState = 'stable';
  });

  setRemoteDescription = vi.fn().mockImplementation(async (desc: any) => {
    this.remoteDescription = desc;
    if (desc.type === 'offer') this.signalingState = 'have-remote-offer';
    else if (desc.type === 'answer') this.signalingState = 'stable';
  });

  createDataChannel = vi.fn().mockReturnValue({
    readyState: 'open',
    onopen: null,
    onerror: null,
    onmessage: null,
  });

  close = vi.fn().mockImplementation(() => {
    this.connectionState = 'closed';
  });

  /** 測試輔助：觸發 connectionState 變更 */
  _setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

global.RTCPeerConnection = MockRTCPeerConnection as unknown as typeof RTCPeerConnection;
global.RTCIceCandidate = vi.fn().mockImplementation(function (init: any) { Object.assign(this, init); }) as unknown as typeof RTCIceCandidate;
global.RTCSessionDescription = vi.fn().mockImplementation(function (init: any) { Object.assign(this, init); }) as unknown as typeof RTCSessionDescription;

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeSignal(
  type: 'offer' | 'answer' | 'ice',
  from: string,
  payload: any = {}
): Signal {
  return { type, from, payload, signalId: `sig-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } as Signal;
}

/** RTDB onChildAdded で signal を 1 件ずつ配信 */
async function emitSignals(manager: any, ...signals: Signal[]) {
  if (!capturedOnChildAddedCb) throw new Error('onChildAdded callback not captured');
  for (const sig of signals) {
    capturedOnChildAddedCb({
      key: sig.signalId,
      val: () => ({ ...sig }),
      ref: mockRef,
    });
  }
  // 等待 signalMutex 鏈完成（所有排隊的 handleSignal 都已執行完畢）
  await manager['signalMutex'];
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('P2PConnectionManager', () => {
  const ROOM_ID = 'room-test';
  const LOCAL_UID = 'user-local';
  const REMOTE_UID = 'user-remote';

  let manager: any; // P2PConnectionManager (avoid circular dep with firebase mock)
  let pc: MockRTCPeerConnection;

  beforeEach(async () => {
    capturedOnChildAddedCb = null;
    mockSet.mockClear();
    mockPush.mockClear();
    mockOnChildAdded.mockClear();
    mockGet.mockClear();
    mockRemove.mockClear();
    mockOnDisconnect.mockClear();
    mockOnDisconnectRemove.mockClear();

    // Dynamic import AFTER mocks are set up
    const { P2PConnectionManager } = await import('../../src/core/p2p/P2PConnectionManager');
    manager = new P2PConnectionManager(ROOM_ID, LOCAL_UID);
    await manager.initialize();

    // Grab the mock PC instance created inside initialize()
    pc = MockRTCPeerConnection.mock?.instances?.[0] ??
      (manager['pc'] as unknown as MockRTCPeerConnection);
  });

  afterEach(async () => {
    await manager.close();
    vi.resetModules();
    // Reset constructor mock instance list
    (MockRTCPeerConnection as any).mock = undefined;
  });

  // ── ICE buffering ────────────────────────────────────────────────────────
  describe('ICE candidate buffering (RTDB desc-order 問題)', () => {
    it('ICE 先到、offer 後到 → ICE 先 buffer，offer 處理後 flush', async () => {
      const iceSignal = makeSignal('ice', REMOTE_UID, {
        candidate: 'candidate:1',
        sdpMid: '0',
        sdpMLineIndex: 0,
      });
      const offerSignal = makeSignal('offer', REMOTE_UID, {
        type: 'offer',
        sdp: 'offer-sdp',
      });

      // RTDB desc 順序：ICE 先送達
      await emitSignals(manager, iceSignal);
      // remoteDescription 尚未設定 → addIceCandidate 不應被呼叫
      expect(pc.addIceCandidate).not.toHaveBeenCalled();

      // 接著送達 offer
      await emitSignals(manager, offerSignal);
      // setRemoteDescription 應被呼叫
      expect(pc.setRemoteDescription).toHaveBeenCalled();
      // buffer flush → addIceCandidate 應被呼叫一次（buffered candidate）
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
      expect(pc.addIceCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'candidate:1' })
      );
    });

    it('多個 ICE 先到 → 全部 buffer，offer 後一次 flush', async () => {
      const ice1 = makeSignal('ice', REMOTE_UID, { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 });
      const ice2 = makeSignal('ice', REMOTE_UID, { candidate: 'c2', sdpMid: '0', sdpMLineIndex: 0 });
      const ice3 = makeSignal('ice', REMOTE_UID, { candidate: 'c3', sdpMid: '0', sdpMLineIndex: 0 });
      const offer = makeSignal('offer', REMOTE_UID, { type: 'offer', sdp: 'offer-sdp' });

      await emitSignals(manager, ice1, ice2, ice3); // all buffered
      expect(pc.addIceCandidate).not.toHaveBeenCalled();

      await emitSignals(manager, offer); // flush
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(3);
    });

    it('ICE 先到、answer 後到（initiator 側）→ ICE buffer → answer 處理後 flush', async () => {
      // Initiator 先 createOffer，然後收到 ICE 和 answer
      await manager.createOffer();
      // pc.signalingState = 'have-local-offer' (mocked)

      const iceSignal = makeSignal('ice', REMOTE_UID, { candidate: 'c-ans', sdpMid: '0', sdpMLineIndex: 0 });
      const answerSignal = makeSignal('answer', REMOTE_UID, { type: 'answer', sdp: 'answer-sdp' });

      // ICE 先到（desc order 問題）
      await emitSignals(manager, iceSignal);
      expect(pc.addIceCandidate).not.toHaveBeenCalled();

      // answer 後到
      await emitSignals(manager, answerSignal);
      expect(pc.setRemoteDescription).toHaveBeenCalled();
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
      expect(pc.addIceCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'c-ans' })
      );
    });

    it('offer 已先到 → 後續 ICE 直接 addIceCandidate，不走 buffer', async () => {
      const offer = makeSignal('offer', REMOTE_UID, { type: 'offer', sdp: 'offer-sdp' });
      const ice = makeSignal('ice', REMOTE_UID, { candidate: 'c-direct', sdpMid: '0', sdpMLineIndex: 0 });

      await emitSignals(manager, offer); // sets remoteDescription
      await emitSignals(manager, ice);   // should be added directly

      // addIceCandidate 只呼叫一次（直接加，非 flush）
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
      expect(pc.addIceCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'c-direct' })
      );
    });

    it('close() 後 buffer 清空（不會殘留 candidate）', async () => {
      const ice = makeSignal('ice', REMOTE_UID, { candidate: 'c-lost', sdpMid: '0', sdpMLineIndex: 0 });
      await emitSignals(manager, ice); // buffered

      await manager.close();

      // 確認 pendingIceCandidates 已清空（透過 private 欄位存取）
      expect((manager as any).pendingIceCandidates).toHaveLength(0);
    });
  });

  // ── Signal 過濾 ───────────────────────────────────────────────────────────
  describe('Signal 過濾', () => {
    it('自己送出的 offer 應忽略（from === localUid）', async () => {
      const selfOffer = makeSignal('offer', LOCAL_UID, { type: 'offer', sdp: 'self-offer' });
      await emitSignals(manager, selfOffer);
      expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    });

    it('自己送出的 ICE 應忽略', async () => {
      const selfIce = makeSignal('ice', LOCAL_UID, { candidate: 'self-c', sdpMid: '0', sdpMLineIndex: 0 });
      await emitSignals(manager, selfIce);
      expect(pc.addIceCandidate).not.toHaveBeenCalled();
    });
  });

  // ── Duplicate answer 忽略 ─────────────────────────────────────────────────
  describe('重複訊號處理', () => {
    it('已有 remoteDescription 時重複 answer 應忽略', async () => {
      await manager.createOffer();

      const ans1 = makeSignal('answer', REMOTE_UID, { type: 'answer', sdp: 'answer-1' });
      const ans2 = makeSignal('answer', REMOTE_UID, { type: 'answer', sdp: 'answer-2' });

      await emitSignals(manager, ans1);
      expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);

      await emitSignals(manager, ans2);
      // second answer should be ignored
      expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
    });

    it('非 stable state 時 offer 應忽略', async () => {
      await manager.createOffer();
      // signalingState is now 'have-local-offer', not 'stable'

      const remoteOffer = makeSignal('offer', REMOTE_UID, { type: 'offer', sdp: 'remote-offer' });
      await emitSignals(manager, remoteOffer);
      // offer ignored because signalingState !== 'stable'
      expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    });
  });

  // ── onStateChange ────────────────────────────────────────────────────────
  describe('onStateChange', () => {
    it('initialize() 後 state は connecting', () => {
      expect(manager.getState()).toBe('connecting');
    });

    it('PeerConnection が connected になると state も connected になる', () => {
      const listener = vi.fn();
      manager.onStateChange(listener);

      pc._setConnectionState('connected');

      expect(listener).toHaveBeenCalledWith('connected');
      expect(manager.getState()).toBe('connected');
    });

    it('PeerConnection が failed になると auto-reconnect が始まる（state は connecting のまま）', () => {
      pc._setConnectionState('failed');

      // Auto-reconnect kicks in: reconnectAttempt increments
      // State stays 'connecting' (from initialize) — no duplicate transition
      expect(manager.getState()).toBe('connecting');
      expect(manager.getReconnectAttempt()).toBe(1);
    });

    it('close() を呼ぶと state は closed になる', async () => {
      const listener = vi.fn();
      manager.onStateChange(listener);
      await manager.close();
      expect(listener).toHaveBeenCalledWith('closed');
    });

    it('unsubscribe 後はコールバックが呼ばれない', () => {
      const listener = vi.fn();
      const unsub = manager.onStateChange(listener);
      unsub();

      pc._setConnectionState('connected');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── sendSignal ───────────────────────────────────────────────────────────
  describe('createOffer() → sendSignal', () => {
    it('createOffer() は RTDB に offer signal を書き込む', async () => {
      await manager.createOffer();
      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'offer', from: LOCAL_UID })
      );
    });

    it('createOffer() は setLocalDescription を呼ぶ', async () => {
      await manager.createOffer();
      expect(pc.setLocalDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer' })
      );
    });
  });
});
