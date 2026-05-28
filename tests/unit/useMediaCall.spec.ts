/**
 * useMediaCall unit tests.
 *
 * Mocks P2PChannelBus + P2PMediaService and exercises the state machine:
 *   - startCall transitions idle → requesting and sends CALL_REQUEST
 *   - receiving CALL_ACCEPT transitions to connected
 *   - receiving CALL_DECLINE during 'requesting' transitions to ended
 *   - receiving CALL_REQUEST while idle transitions to ringing
 *   - answerCall → 'connected' + CALL_ACCEPT sent
 *   - declineCall → CALL_DECLINE sent + state ended
 *   - endCall from connected stops local media
 *   - toggleMute / toggleCamera mirror the service's audio/video state
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaCall } from '../../src/features/chat/hooks/useMediaCall';
import type { P2PEnvelope } from '../../src/types';

// ── Mock channelBus ──────────────────────────────────────────────────────
function makeMockChannelBus() {
  let handler: ((env: P2PEnvelope) => void) | null = null;
  return {
    send: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_ns: string, h: (env: P2PEnvelope) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }),
    /** Test helper — simulate inbound envelope */
    emit(env: P2PEnvelope) {
      handler?.(env);
    },
  };
}

// ── Mock mediaService ────────────────────────────────────────────────────
function makeMockMediaService() {
  const state = { audioEnabled: false, videoEnabled: false, audioMuted: false, videoMuted: false };
  const fakeStream = { getTracks: () => [] } as unknown as MediaStream;
  let remoteListener: ((s: MediaStream | null) => void) | null = null;
  return {
    startLocalMedia: vi.fn().mockResolvedValue(fakeStream),
    stopLocalMedia: vi.fn(),
    toggleAudio: vi.fn(() => {
      state.audioMuted = !state.audioMuted;
    }),
    toggleVideo: vi.fn(() => {
      state.videoMuted = !state.videoMuted;
    }),
    getMediaState: () => ({ ...state }),
    onRemoteStreamChange: (cb: (s: MediaStream | null) => void) => {
      remoteListener = cb;
      return () => {
        remoteListener = null;
      };
    },
    fakeStream,
    /** Test helper — push remote stream */
    emitRemoteStream(s: MediaStream | null) {
      remoteListener?.(s);
    },
  };
}

const LOCAL_ID = 'self/dev-1';
const REMOTE_ID = 'remote/dev-2';

function envelope(
  type: 'CALL_REQUEST' | 'CALL_ACCEPT' | 'CALL_DECLINE' | 'MEDIA_END',
  from: string,
  payload: Record<string, unknown> = {},
): P2PEnvelope {
  return {
    v: 1,
    ns: 'media',
    type,
    id: `env-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    from,
    payload,
  };
}

describe('useMediaCall', () => {
  let bus: ReturnType<typeof makeMockChannelBus>;
  let media: ReturnType<typeof makeMockMediaService>;

  beforeEach(() => {
    bus = makeMockChannelBus();
    media = makeMockMediaService();
  });

  it('begins in idle', () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    expect(result.current.state).toBe('idle');
    expect(result.current.callType).toBeNull();
  });

  it('startCall("audio") goes idle → requesting and sends CALL_REQUEST', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    await act(async () => {
      await result.current.startCall('audio');
    });
    expect(result.current.state).toBe('requesting');
    expect(result.current.callType).toBe('audio');
    expect(media.startLocalMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(bus.send).toHaveBeenCalledTimes(1);
    const sent = bus.send.mock.calls[0][0] as P2PEnvelope;
    expect(sent.type).toBe('CALL_REQUEST');
    expect(sent.from).toBe(LOCAL_ID);
    expect((sent.payload as { callType: string }).callType).toBe('audio');
  });

  it('startCall("video") asks for both audio+video', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    await act(async () => {
      await result.current.startCall('video');
    });
    expect(media.startLocalMedia).toHaveBeenCalledWith({ audio: true, video: true });
  });

  it('receiving CALL_ACCEPT while requesting transitions to connected', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    await act(async () => {
      await result.current.startCall('audio');
    });
    expect(result.current.state).toBe('requesting');
    act(() => {
      bus.emit(envelope('CALL_ACCEPT', REMOTE_ID, { callType: 'audio' }));
    });
    expect(result.current.state).toBe('connected');
  });

  it('receiving CALL_REQUEST while idle transitions to ringing', () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    act(() => {
      bus.emit(envelope('CALL_REQUEST', REMOTE_ID, { callType: 'video' }));
    });
    expect(result.current.state).toBe('ringing');
    expect(result.current.callType).toBe('video');
  });

  it('answerCall sends CALL_ACCEPT and transitions to connected', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    act(() => {
      bus.emit(envelope('CALL_REQUEST', REMOTE_ID, { callType: 'audio' }));
    });
    await act(async () => {
      await result.current.answerCall();
    });
    expect(result.current.state).toBe('connected');
    expect(media.startLocalMedia).toHaveBeenCalledWith({ audio: true, video: false });
    const sent = bus.send.mock.calls[bus.send.mock.calls.length - 1][0] as P2PEnvelope;
    expect(sent.type).toBe('CALL_ACCEPT');
  });

  it('declineCall sends CALL_DECLINE and ends the call', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    act(() => {
      bus.emit(envelope('CALL_REQUEST', REMOTE_ID, { callType: 'audio' }));
    });
    await act(async () => {
      await result.current.declineCall('busy');
    });
    expect(result.current.state).toBe('ended');
    const sent = bus.send.mock.calls[bus.send.mock.calls.length - 1][0] as P2PEnvelope;
    expect(sent.type).toBe('CALL_DECLINE');
    expect((sent.payload as { reason?: string }).reason).toBe('busy');
  });

  it('receiving CALL_DECLINE during requesting transitions to ended', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    await act(async () => {
      await result.current.startCall('audio');
    });
    act(() => {
      bus.emit(envelope('CALL_DECLINE', REMOTE_ID, { reason: 'busy' }));
    });
    expect(result.current.state).toBe('ended');
    expect(media.stopLocalMedia).toHaveBeenCalled();
  });

  it('endCall from connected stops local media and transitions to ended', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    act(() => {
      bus.emit(envelope('CALL_REQUEST', REMOTE_ID, { callType: 'audio' }));
    });
    await act(async () => {
      await result.current.answerCall();
    });
    expect(result.current.state).toBe('connected');
    await act(async () => {
      await result.current.endCall();
    });
    expect(result.current.state).toBe('ended');
    expect(media.stopLocalMedia).toHaveBeenCalled();
  });

  it('ignores self-sent envelopes', () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    act(() => {
      bus.emit(envelope('CALL_REQUEST', LOCAL_ID, { callType: 'audio' }));
    });
    expect(result.current.state).toBe('idle');
  });

  it('auto-declines a second CALL_REQUEST while busy', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    // first call → connected
    act(() => {
      bus.emit(envelope('CALL_REQUEST', REMOTE_ID, { callType: 'audio' }));
    });
    await act(async () => {
      await result.current.answerCall();
    });
    bus.send.mockClear();

    // second incoming request → auto-decline
    act(() => {
      bus.emit(envelope('CALL_REQUEST', 'someone-else/dev', { callType: 'audio' }));
    });
    expect(bus.send).toHaveBeenCalledTimes(1);
    const sent = bus.send.mock.calls[0][0] as P2PEnvelope;
    expect(sent.type).toBe('CALL_DECLINE');
    expect((sent.payload as { reason?: string }).reason).toBe('busy');
    // Still in the original connected call
    expect(result.current.state).toBe('connected');
  });

  it('toggleMute mirrors media service mute state', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    expect(result.current.audioMuted).toBe(false);
    act(() => result.current.toggleMute());
    expect(media.toggleAudio).toHaveBeenCalled();
    expect(result.current.audioMuted).toBe(true);
    act(() => result.current.toggleMute());
    expect(result.current.audioMuted).toBe(false);
  });

  it('toggleCamera mirrors media service video-mute state', () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: media as never,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    expect(result.current.videoMuted).toBe(false);
    act(() => result.current.toggleCamera());
    expect(result.current.videoMuted).toBe(true);
  });

  it('startCall throws when service is unavailable', async () => {
    const { result } = renderHook(() =>
      useMediaCall({
        mediaService: null,
        channelBus: bus as never,
        localId: LOCAL_ID,
      }),
    );
    await expect(result.current.startCall('audio')).rejects.toThrow(/not ready/);
  });
});
