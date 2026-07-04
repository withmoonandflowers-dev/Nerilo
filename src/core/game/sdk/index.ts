export { GameTransportSDK } from './GameTransportSDK';
export type { IGameBroadcast } from './GameTransportSDK';
export { GameSession } from './GameSession';
export { GameFeature, setGameFeatureCallbacks } from './GameFeature';
export { DeterministicRNG } from './DeterministicRNG';
export { GameStateStore } from './GameStateStore';
export type { IGameStateStorage } from './GameStateStore';
export { GameMsgType } from './GameMessageTypes';
export type {
  GameInputPayload,
  StateHashPayload,
  SeedCommitPayload,
  SeedRevealPayload,
  SessionJoinPayload,
  HostMigratedPayload,
  SnapshotResponsePayload,
  GameStartPayload,
} from './GameMessageTypes';
export type {
  SessionState,
  PeerInfo,
  PeerState,
  GameSessionConfig,
  GameTransportSDKConfig,
  GameSDKEvent,
  RNGState,
  SerializedSessionState,
  GameSnapshotBundle,
} from './types';

// schema-first wire 格式（ADR-0018）
export {
  Writer,
  Reader,
  readerFrom,
  defineComponent,
  u8,
  u16,
  u32,
  i8,
  i16,
  i32,
  f32,
  f64,
  varint,
  bool,
  str,
  q8,
} from './schema';
export type { FieldCodec, ComponentSchema, ComponentDescriptor, InferData } from './schema';
export { defineInput } from './InputCodec';
export type { InputSchema, InputDescriptor } from './InputCodec';

// 狀態幀（unreliable state 通道，ADR-0019）
export { defineStateFrame, createFrameGate } from './StateFrameCodec';
export type { StateFrame, StateFrameDescriptor, FrameGate } from './StateFrameCodec';
