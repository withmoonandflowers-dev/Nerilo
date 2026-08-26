/**
 * Nerilo 可嵌入 SDK 主出口（`nerilo`）——純公開契約，零 Firebase 型別。
 *
 * 第三方只依賴此檔匯出的東西即為「穩定契約」；內部 mesh / gossip / crypto 類別不列入，
 * 可自由重構。本入口**不含**動態載入 Firestore 的重型工廠——那在 subpath `nerilo/firestore`
 * （架構收斂 2026-07：讓主入口型別表面乾淨）。想要 turnkey Firestore 客戶端請 import
 * `nerilo/firestore` 的 createChatClient；想自己注入後端的用本入口的 NeriloClient + ports。
 */

// 門面與注入契約
export { NeriloClient } from './NeriloClient';
export type { Positioned } from './NeriloClient';
export type { IChatEngine } from './IChatEngine';

// 後端可替換的注入縫（介面，純契約；Firestore/Relay 實作不進公開型別）
export type { SignalingTransport, RawSignalDoc, SignalingFactory } from '../core/p2p/SignalingTransport.types';
export type { IChatStorage, IRoomDirectory, RoomSnapshot, DirectoryIdentity, IRoomCatalog, CatalogRoom } from '../ports';
// 純記憶體參考實作(無 Firebase);自架後端可照此形狀
export { InMemorySignalingHub, InMemorySignalingTransport } from '../core/p2p/InMemorySignalingTransport';
export { InMemoryRoomDirectory, InMemoryRoomDirectoryHub } from '../core/mesh/InMemoryRoomDirectory';
export { InMemoryRoomCatalog, InMemoryRoomCatalogHub } from '../core/mesh/InMemoryRoomCatalog';
export { InMemoryChatStorage } from '../core/storage/InMemoryChatStorage';

// 公開資料型別
export type { ChatMessage, HLCTimestamp } from '../types';
export type { NeriloStatus, NeriloTransportState, NeriloEncryptionState } from '../core/messaging/status';
export type { ReactionEvent, ReactionOp, ReactionMap } from '../core/messaging/reactions';
export type { ReadEvent, ReadState } from '../core/messaging/readReceipts';

// 純邏輯(第三方若要自建 UI 聚合可直接用,零依賴、可測)
// 0.11.0 瘦身：encodeContent/decodeContent 移出表面（門面 sendMessage/decode 已包掉，零外部使用者）；
// IRoomService 同批移出（SDK 無任何注入縫吃它，孤兒型別；block-brawl 亦點名過重）。
export { applyReaction, hasReacted } from '../core/messaging/reactions';
export { applyRead, readCount, readersOf, orderKeyOf } from '../core/messaging/readReceipts';

// 斷網會合（Spec 027）：本地會合點工廠與離線邀請碼（雙向雙 QR）
export { createHttpSignaling } from './httpSignaling';
export {
  createOfflineInvite, acceptOfflineInvite,
  encodeInvitePayload, decodeInvitePayload, payloadBytes,
} from './offlineInvite';
export type { OfflineInvite, OfflineLink, InvitePayload } from './offlineInvite';

// turnkey Firestore 工廠（createChatClient）在 subpath：
//   import { createChatClient } from 'nerilo/firestore'
// 拆出的原因：那條路徑動態載入 MeshChatService，會把 mesh/crypto 型別圖帶進來；
// 主入口保持純契約、型別表面乾淨。
