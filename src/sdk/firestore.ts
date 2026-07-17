/**
 * Nerilo SDK — Firestore turnkey 工廠出口（subpath：`nerilo/firestore`）。
 *
 * 這裡是唯一動態載入 Firestore-backed `MeshChatService` 的地方，故本入口的型別圖含
 * mesh/relay/crypto。想要「純注入、零 Firebase 型別」的消費者請改用主入口 `nerilo`
 * （NeriloClient + ports + InMemory 參考實作 + 純 reducer），本檔留給要 turnkey 的人。
 *
 * 架構收斂 2026-07：把重型工廠從主 barrel 拆出，讓 `nerilo` 的公開型別表面乾淨。
 */
import { NeriloClient } from './NeriloClient';
import type { IChatEngine } from './IChatEngine';
import type { SignalingFactory } from '../core/p2p/SignalingTransport.types';
import type { IRoomDirectory, IChatStorage } from '../ports';

/**
 * 通用工廠：建一個 NeriloClient。三個後端全可注入（signaling / directory / storage）。
 * 省略者延到 initialize() 才動態載入預設 Firestore/IndexedDB —— 故全部注入時，這條建構路徑
 * 的靜態相依圖無 Firebase（見 sdkSurface 測試；MeshChatService 圖已 0 firebase）。
 */
export async function createChatClient(config: {
  roomId: string;
  userId: string;
  signaling?: SignalingFactory; // 省略＝Firestore（延遲）
  directory?: IRoomDirectory;   // 省略＝Firestore（延遲）
  storage?: IChatStorage;       // 省略＝IndexedDB（瀏覽器）
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
  signaling?: SignalingFactory;
  directory?: IRoomDirectory;
}): Promise<NeriloClient> {
  return createChatClient(config);
}
