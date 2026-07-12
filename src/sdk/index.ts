/**
 * Nerilo 可嵌入 SDK 公開出口(L2 地基)。
 *
 * 第三方只依賴此檔匯出的東西即為「穩定契約」;內部 mesh / gossip / crypto 類別不列入,
 * 可自由重構。現況(P1):預設工廠 createFirestoreChatClient 仍以既有 Firestore 後端為底
 * (需已初始化的 Firebase 環境)。P2 會把 signaling / auth 改為可注入,屆時同一個
 * NeriloClient 可換上自架 WebSocket 等後端而 API 不變。
 */
import { NeriloClient } from './NeriloClient';
import type { IChatEngine } from './IChatEngine';

// 門面與注入契約
export { NeriloClient } from './NeriloClient';
export type { Positioned } from './NeriloClient';
export type { IChatEngine } from './IChatEngine';

// 後端可替換的注入縫(Firestore 與 Relay 皆已實作 SignalingTransport)
export type { SignalingTransport, RawSignalDoc, SignalingFactory } from '../core/p2p/SignalingTransport';
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

/**
 * 預設工廠:以既有 Firestore-backed MeshChatService 建立引擎並包成 NeriloClient。
 * 需在已初始化 Firebase 的環境呼叫(P1 限制;P2 提供可注入後端的工廠)。
 * 用動態 import 讓「只取型別/純函式」的引用不會把 Firebase 靜態拉進相依圖。
 */
/**
 * 通用工廠：建一個 NeriloClient。三個後端全可注入（signaling / directory / storage）。
 * 省略者延到 initialize() 才動態載入預設 Firestore/IndexedDB —— 故**全部注入時，這條建構路徑
 * 的靜態相依圖無 Firebase**（見 sdkSurface 測試；MeshChatService 圖已 0 firebase）。
 */
export async function createChatClient(config: {
  roomId: string;
  userId: string;
  signaling?: import('../core/p2p/SignalingTransport').SignalingFactory; // 省略＝Firestore（延遲）
  directory?: import('../ports').IRoomDirectory;                          // 省略＝Firestore（延遲）
  storage?: import('../ports').IChatStorage;                              // 省略＝IndexedDB（瀏覽器）
}): Promise<NeriloClient> {
  const { MeshChatService } = await import('../features/chat/MeshChatService');
  const engine: IChatEngine = new MeshChatService(
    config.roomId, config.userId, config.storage, config.signaling, config.directory
  );
  return new NeriloClient(engine);
}

/** Firestore 便利工廠（＝createChatClient 省略後端 → 延遲載入 Firestore/IndexedDB 預設）。 */
export async function createFirestoreChatClient(config: {
  roomId: string;
  userId: string;
  signaling?: import('../core/p2p/SignalingTransport').SignalingFactory;
  directory?: import('../ports').IRoomDirectory;
}): Promise<NeriloClient> {
  return createChatClient(config);
}
