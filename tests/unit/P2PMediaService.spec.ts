/**
 * P2PMediaService smoke tests
 *
 * Closes the README-claims-feature-but-zero-tests gap from the CIO audit.
 * Verifies the surface contract — initialization, lifecycle, peer-connection
 * attachment, state/stream listeners — without exercising real WebRTC.
 *
 * RTCPeerConnection and getUserMedia are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { P2PEnvelope, MediaState } from '../../src/types';

// ── P2PChannelBus mock (avoid importing real DataChannel wiring) ──────────────
class MockChannelBus {
  private subs: Map<string, (env: P2PEnvelope) => void | Promise<void>> = new Map();
  send = vi.fn().mockResolvedValue(undefined);
  subscribe(ns: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void {
    this.subs.set(ns, handler);
    return () => this.subs.delete(ns);
  }
  /** Test helper — simulate inbound envelope */
  async emit(env: P2PEnvelope) {
    const h = this.subs.get(env.ns);
    if (h) await h(env);
  }
}

// ── RTCPeerConnection mock ───────────────────────────────────────────────────
function makeMockPeerConnection() {
  const senders: RTCRtpSender[] = [];
  return {
    ontrack: null as ((e: RTCTrackEvent) => void) | null,
    onnegotiationneeded: null as (() => void) | null,
    addTrack: vi.fn((track: MediaStreamTrack) => {
      const sender = { track } as unknown as RTCRtpSender;
      senders.push(sender);
      return sender;
    }),
    removeTrack: vi.fn((sender: RTCRtpSender) => {
      const idx = senders.indexOf(sender);
      if (idx >= 0) senders.splice(idx, 1);
    }),
    getSenders: vi.fn(() => [...senders]),
  };
}

// ── MediaStream mock ─────────────────────────────────────────────────────────
function makeMockTrack(kind: 'audio' | 'video') {
  return {
    kind,
    enabled: true,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function makeMockStream(audio = true, video = true) {
  const tracks: MediaStreamTrack[] = [];
  if (audio) tracks.push(makeMockTrack('audio'));
  if (video) tracks.push(makeMockTrack('video'));
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

describe('P2PMediaService (smoke)', () => {
  let bus: MockChannelBus;
  let pc: ReturnType<typeof makeMockPeerConnection>;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new MockChannelBus();
    pc = makeMockPeerConnection();
    getUserMedia = vi.fn();
    // navigator is read-only in node — use stubGlobal so vitest can restore it
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructor wires the media subscription and peer-connection handlers', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );
    expect(pc.ontrack).toBeTypeOf('function');
    expect(pc.onnegotiationneeded).toBeTypeOf('function');
  });

  it('startLocalMedia acquires stream, attaches tracks, sends MEDIA_READY', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    const stream = makeMockStream(true, true);
    getUserMedia.mockResolvedValue(stream);

    const result = await service.startLocalMedia({ audio: true, video: true });

    expect(result).toBe(stream);
    expect(pc.addTrack).toHaveBeenCalledTimes(2);
    expect(service.getLocalStream()).toBe(stream);
    expect(service.getMediaState()).toEqual({
      audioEnabled: true,
      videoEnabled: true,
      audioMuted: false,
      videoMuted: false,
    });
    // MEDIA_READY envelope dispatched
    expect(bus.send).toHaveBeenCalledTimes(1);
    const env = bus.send.mock.calls[0][0] as P2PEnvelope;
    expect(env.ns).toBe('media');
    expect(env.type).toBe('MEDIA_READY');
  });

  it('startLocalMedia stops tracks if addTrack throws (avoid camera LED leak)', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    const stream = makeMockStream(true, true);
    const stopSpy = vi.spyOn(stream.getTracks()[0], 'stop');
    getUserMedia.mockResolvedValue(stream);
    pc.addTrack.mockImplementationOnce(() => {
      throw new Error('addTrack failed');
    });

    await expect(service.startLocalMedia({ audio: true, video: true })).rejects.toThrow(
      'addTrack failed',
    );
    expect(stopSpy).toHaveBeenCalled();
    expect(service.getLocalStream()).toBeNull();
  });

  it('stopLocalMedia stops tracks and removes senders', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    const stream = makeMockStream(true, true);
    getUserMedia.mockResolvedValue(stream);
    await service.startLocalMedia({ audio: true, video: true });

    const stopSpies = stream.getTracks().map((t) => vi.spyOn(t, 'stop'));
    service.stopLocalMedia();

    for (const spy of stopSpies) expect(spy).toHaveBeenCalled();
    expect(pc.removeTrack).toHaveBeenCalledTimes(2);
    expect(service.getLocalStream()).toBeNull();
    expect(service.getMediaState().audioEnabled).toBe(false);
    expect(service.getMediaState().videoEnabled).toBe(false);
  });

  it('toggleAudio / toggleVideo flip track.enabled and broadcast MEDIA_TOGGLE', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    const stream = makeMockStream(true, true);
    getUserMedia.mockResolvedValue(stream);
    await service.startLocalMedia({ audio: true, video: true });
    bus.send.mockClear();

    service.toggleAudio();
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
    expect(service.getMediaState().audioMuted).toBe(true);

    service.toggleVideo();
    expect(stream.getVideoTracks()[0].enabled).toBe(false);
    expect(service.getMediaState().videoMuted).toBe(true);

    // Each toggle dispatches a MEDIA_TOGGLE envelope
    const sendCalls = bus.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of sendCalls) {
      expect((c[0] as P2PEnvelope).type).toBe('MEDIA_TOGGLE');
    }
  });

  it('remote MEDIA_TOGGLE updates local mediaState mirrors', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    const listener = vi.fn();
    service.onStateChange(listener);

    await bus.emit({
      v: 1,
      ns: 'media',
      type: 'MEDIA_TOGGLE',
      id: 'x',
      ts: Date.now(),
      from: 'uid-remote/dev',
      payload: { audioMuted: true, videoMuted: true },
    });

    expect(listener).toHaveBeenCalled();
    const final = listener.mock.calls[listener.mock.calls.length - 1][0] as MediaState;
    expect(final.audioMuted).toBe(true);
    expect(final.videoMuted).toBe(true);
  });

  it('peer ontrack callback exposes the remote stream to listeners', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    const remoteStream = makeMockStream();
    const streamListener = vi.fn();
    service.onRemoteStreamChange(streamListener);

    pc.ontrack!({ streams: [remoteStream] } as unknown as RTCTrackEvent);

    expect(service.getRemoteStream()).toBe(remoteStream);
    expect(streamListener).toHaveBeenCalledWith(remoteStream);
  });

  it('remote MEDIA_END clears the remote stream', async () => {
    const { P2PMediaService } = await import('../../src/core/p2p/P2PMediaService');
    const service = new P2PMediaService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      pc as unknown as RTCPeerConnection,
      'uid-self',
      'device-1',
    );

    pc.ontrack!({ streams: [makeMockStream()] } as unknown as RTCTrackEvent);
    expect(service.getRemoteStream()).not.toBeNull();

    const streamListener = vi.fn();
    service.onRemoteStreamChange(streamListener);

    await bus.emit({
      v: 1, ns: 'media', type: 'MEDIA_END',
      id: 'x', ts: Date.now(), from: 'uid-remote/dev', payload: {},
    });

    expect(service.getRemoteStream()).toBeNull();
    expect(streamListener).toHaveBeenCalledWith(null);
  });
});
