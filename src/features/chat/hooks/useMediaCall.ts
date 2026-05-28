/**
 * useMediaCall — Voice/video call state machine over an existing P2P session.
 *
 *   idle ──startCall──▶ requesting ──CALL_ACCEPT──▶ connected ──end──▶ ended
 *    ▲                       │                        │             │
 *    │                       └──CALL_DECLINE──▶ ended ◀─────────────┘
 *    │
 *    └──CALL_REQUEST received──▶ ringing ──answer──▶ connected
 *                                    │
 *                                    └──decline──▶ ended
 *
 * Sits on top of P2PMediaService (which manages getUserMedia + addTrack +
 * MEDIA_TOGGLE / MEDIA_END envelopes). This hook adds the call-signalling
 * layer (CALL_REQUEST / CALL_ACCEPT / CALL_DECLINE) that the underlying
 * service deliberately doesn't know about, so it can stay a thin wrapper.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { P2PChannelBus } from '../../../core/p2p/P2PChannelBus';
import type { P2PMediaService } from '../../../core/p2p/P2PMediaService';
import type { P2PEnvelope } from '../../../types';
import { generateUUID } from '../../../utils/uuid';
import { logger } from '../../../utils/logger';

export type CallState = 'idle' | 'requesting' | 'ringing' | 'connected' | 'ended';
export type CallType = 'audio' | 'video';

interface CallRequestPayload {
  callType: CallType;
}
interface CallAcceptPayload {
  callType: CallType;
}
interface CallDeclinePayload {
  reason?: string;
}

export interface UseMediaCallOptions {
  /** P2PMediaService instance — null until the DataChannel is open. */
  mediaService: P2PMediaService | null;
  /** Same channelBus the media service uses — needed to send call-signalling envelopes. */
  channelBus: P2PChannelBus | null;
  /** Identifier used as envelope.from, conventionally `${uid}/${deviceId}`. */
  localId: string;
}

export interface UseMediaCallResult {
  /** Current state machine position. */
  state: CallState;
  /** Type of the in-flight call, or null. */
  callType: CallType | null;
  /** Local MediaStream after startCall/answerCall, or null. */
  localStream: MediaStream | null;
  /** Remote MediaStream once the peer attaches tracks, or null. */
  remoteStream: MediaStream | null;
  /** ms since the call entered 'connected'. Resets to 0 on every state change. */
  callDurationMs: number;
  /** True if local audio track is muted. */
  audioMuted: boolean;
  /** True if local video track is muted (video-off). */
  videoMuted: boolean;
  /** Begin an outgoing call. Throws if mediaService is unavailable. */
  startCall: (callType: CallType) => Promise<void>;
  /** Accept a ringing call. */
  answerCall: () => Promise<void>;
  /** Decline a ringing call. */
  declineCall: (reason?: string) => Promise<void>;
  /** Hang up an active or in-flight call. */
  endCall: () => Promise<void>;
  /** Toggle local audio mute. */
  toggleMute: () => void;
  /** Toggle local camera (video tracks). */
  toggleCamera: () => void;
}

const CALL_NAMESPACE = 'media' as const;
const TYPE_REQUEST = 'CALL_REQUEST' as const;
const TYPE_ACCEPT = 'CALL_ACCEPT' as const;
const TYPE_DECLINE = 'CALL_DECLINE' as const;

function makeEnvelope(
  type: typeof TYPE_REQUEST | typeof TYPE_ACCEPT | typeof TYPE_DECLINE,
  from: string,
  payload: CallRequestPayload | CallAcceptPayload | CallDeclinePayload,
): P2PEnvelope {
  return {
    v: 1,
    ns: CALL_NAMESPACE,
    type,
    id: generateUUID(),
    ts: Date.now(),
    from,
    payload,
  };
}

export function useMediaCall(options: UseMediaCallOptions): UseMediaCallResult {
  const { mediaService, channelBus, localId } = options;

  const [state, setState] = useState<CallState>('idle');
  const [callType, setCallType] = useState<CallType | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callDurationMs, setCallDurationMs] = useState(0);
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);

  // Refs let our envelope-handler callbacks see latest state without
  // triggering re-subscribes every render.
  const stateRef = useRef(state);
  stateRef.current = state;
  const callTypeRef = useRef(callType);
  callTypeRef.current = callType;
  const localStreamRef = useRef(localStream);
  localStreamRef.current = localStream;

  // ── Helper: reset everything to 'idle' ───────────────────────────────────
  const reset = useCallback(() => {
    if (localStreamRef.current) {
      mediaService?.stopLocalMedia();
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setCallType(null);
    setCallDurationMs(0);
    setAudioMuted(false);
    setVideoMuted(false);
    setState('ended');
  }, [mediaService]);

  // ── Outgoing: startCall ──────────────────────────────────────────────────
  const startCall = useCallback(
    async (type: CallType) => {
      if (!mediaService || !channelBus) {
        throw new Error('Media service or channel bus not ready');
      }
      if (stateRef.current !== 'idle' && stateRef.current !== 'ended') {
        throw new Error(`Cannot start call in state ${stateRef.current}`);
      }
      logger.info('[useMediaCall] startCall', { type });
      setState('requesting');
      setCallType(type);
      try {
        // Acquire local media first so we can attach tracks as soon as the
        // remote accepts. If permission is denied we error before sending
        // the request envelope.
        const stream = await mediaService.startLocalMedia({
          audio: true,
          video: type === 'video',
        });
        setLocalStream(stream);
        localStreamRef.current = stream;
        await channelBus.send(makeEnvelope(TYPE_REQUEST, localId, { callType: type }));
      } catch (err) {
        logger.error('[useMediaCall] startCall failed', err);
        reset();
        throw err;
      }
    },
    [mediaService, channelBus, localId, reset],
  );

  // ── Incoming: answer / decline ───────────────────────────────────────────
  const answerCall = useCallback(async () => {
    if (!mediaService || !channelBus) {
      throw new Error('Media service or channel bus not ready');
    }
    if (stateRef.current !== 'ringing' || !callTypeRef.current) {
      throw new Error(`Cannot answer in state ${stateRef.current}`);
    }
    const type = callTypeRef.current;
    logger.info('[useMediaCall] answerCall', { type });
    try {
      const stream = await mediaService.startLocalMedia({
        audio: true,
        video: type === 'video',
      });
      setLocalStream(stream);
      localStreamRef.current = stream;
      await channelBus.send(makeEnvelope(TYPE_ACCEPT, localId, { callType: type }));
      setState('connected');
    } catch (err) {
      logger.error('[useMediaCall] answerCall failed', err);
      // Treat permission denial as auto-decline so the caller doesn't ring
      // forever.
      await channelBus
        .send(makeEnvelope(TYPE_DECLINE, localId, { reason: 'media-failure' }))
        .catch(() => undefined);
      reset();
      throw err;
    }
  }, [mediaService, channelBus, localId, reset]);

  const declineCall = useCallback(
    async (reason?: string) => {
      if (!channelBus) return;
      if (stateRef.current !== 'ringing') return;
      logger.info('[useMediaCall] declineCall', { reason });
      await channelBus
        .send(makeEnvelope(TYPE_DECLINE, localId, { reason }))
        .catch(() => undefined);
      reset();
    },
    [channelBus, localId, reset],
  );

  const endCall = useCallback(async () => {
    if (stateRef.current === 'idle') return;
    logger.info('[useMediaCall] endCall', { state: stateRef.current });
    // P2PMediaService doesn't expose a sendMediaEnd helper but its
    // stopLocalMedia removes the tracks; the remote side will see ontrack
    // muted + connection state. We also send a CALL_DECLINE for the
    // 'requesting' case so the ringing peer stops ringing.
    if (channelBus && stateRef.current === 'requesting') {
      await channelBus
        .send(makeEnvelope(TYPE_DECLINE, localId, { reason: 'caller-cancelled' }))
        .catch(() => undefined);
    }
    reset();
  }, [channelBus, localId, reset]);

  // ── Toggles ──────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (!mediaService) return;
    mediaService.toggleAudio();
    const next = mediaService.getMediaState().audioMuted;
    setAudioMuted(next);
  }, [mediaService]);

  const toggleCamera = useCallback(() => {
    if (!mediaService) return;
    mediaService.toggleVideo();
    const next = mediaService.getMediaState().videoMuted;
    setVideoMuted(next);
  }, [mediaService]);

  // ── Subscribe to incoming envelopes ──────────────────────────────────────
  useEffect(() => {
    if (!channelBus) return;
    const handler = (env: P2PEnvelope) => {
      if (env.from === localId) return; // ignore our own envelopes
      switch (env.type) {
        case TYPE_REQUEST: {
          const payload = env.payload as CallRequestPayload;
          if (stateRef.current === 'connected' || stateRef.current === 'requesting') {
            // We're busy — auto-decline so the remote doesn't ring forever.
            channelBus
              .send(makeEnvelope(TYPE_DECLINE, localId, { reason: 'busy' }))
              .catch(() => undefined);
            return;
          }
          setCallType(payload.callType);
          setState('ringing');
          break;
        }
        case TYPE_ACCEPT: {
          if (stateRef.current === 'requesting') {
            setState('connected');
          }
          break;
        }
        case TYPE_DECLINE: {
          if (stateRef.current === 'requesting' || stateRef.current === 'ringing') {
            reset();
          }
          break;
        }
        case 'MEDIA_END': {
          // The peer hung up.
          if (stateRef.current === 'connected') reset();
          break;
        }
      }
    };
    const unsubscribe = channelBus.subscribe(CALL_NAMESPACE, handler);
    return unsubscribe;
  }, [channelBus, localId, reset]);

  // ── Track remote stream from MediaService listener ───────────────────────
  useEffect(() => {
    if (!mediaService) return;
    const unsub = mediaService.onRemoteStreamChange((stream) => {
      setRemoteStream(stream);
    });
    return unsub;
  }, [mediaService]);

  // ── Duration timer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (state !== 'connected') {
      setCallDurationMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setCallDurationMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [state]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (localStreamRef.current) {
        try {
          mediaService?.stopLocalMedia();
        } catch {
          /* ignore */
        }
      }
    };
  }, [mediaService]);

  return {
    state,
    callType,
    localStream,
    remoteStream,
    callDurationMs,
    audioMuted,
    videoMuted,
    startCall,
    answerCall,
    declineCall,
    endCall,
    toggleMute,
    toggleCamera,
  };
}
