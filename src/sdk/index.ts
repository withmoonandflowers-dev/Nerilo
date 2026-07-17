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
export type { IChatStorage, IRoomService, IRoomDirectory, RoomSnapshot, DirectoryIdentity } from '../ports';
// 純記憶體參考實作(無 Firebase);自架後端可照此形狀
export { InMemorySignalingHub, InMemorySignalingTransport } from '../core/p2p/InMemorySignalingTransport';
export { InMemoryRoomDirectory, InMemoryRoomDirectoryHub } from '../core/mesh/InMemoryRoomDirectory';
export { InMemoryChatStorage } from '../core/storage/InMemoryChatStorage';

// 公開資料型別
export type { ChatMessage, HLCTimestamp } from '../types';
export type { ReactionEvent, ReactionOp, ReactionMap } from '../features/chat/reactions';
export type { ReadEvent, ReadState } from '../features/chat/readReceipts';

// 純邏輯(第三方若要自建 UI 聚合可直接用,零依賴、可測)
export { applyReaction, hasReacted } from '../features/chat/reactions';
export { applyRead, readCount, readersOf, orderKeyOf } from '../features/chat/readReceipts';
export { encodeContent, decodeContent } from '../features/chat/messageContent';

// turnkey Firestore 工廠（createChatClient / createFirestoreChatClient）在 subpath：
//   import { createChatClient } from 'nerilo/firestore'
// 拆出的原因：那條路徑動態載入 MeshChatService，會把 mesh/crypto 型別圖帶進來；
// 主入口保持純契約、型別表面乾淨。
