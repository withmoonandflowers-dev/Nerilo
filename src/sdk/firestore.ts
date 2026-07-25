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
import { createLazySignalingTransport } from '../core/p2p/lazySignalingTransport';
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
  // 已知殘留（Spec 013）：MeshChatService 是 mesh 聊天引擎本體，卻還放在 features/ 底下。
  // 這是 SDK 唯一穿過應用層目錄的相依。注意圍籬抓不到它——no-restricted-imports 只看
  // 靜態 import 宣告，動態 import() 不在其射程內，所以這裡是靠註解自律而非機器強制。
  // 收斂綁 ADR-0017：React 產線退役時把 MeshChatService 一併搬進 core，屆時這條註解可刪。
  const { MeshChatService } = await import('../features/chat/MeshChatService');
  const engine: IChatEngine = new MeshChatService(
    config.roomId, config.userId, config.storage, config.signaling, config.directory
  );
  return new NeriloClient(engine);
}

/**
 * Firestore signaling 工廠（Spec 015 T2）——只要牽線、不要整個聊天客戶端的人用這個。
 *
 * 情境：第三方已經有自己的 P2P 應用（遊戲、協作白板），只缺一套「交換 SDP/ICE」的
 * 後端。在此之前 SDK 只公開 `SignalingTransport` **介面**，實作得自己寫一份；
 * Nerilo 明明有一份跑在 production 的卻拿不到（block-brawl 2026-07-25 實測撞到）。
 *
 * 誠實邊界（憲法第 10 條，勿刪）：
 * - 這條通道傳的是 SDP/ICE，**不是**訊息內容；它不提供端到端加密。
 * - 內容對你的 Firestore 後端可見。
 * - SDP 尚未簽章（GOAL-ANALYSIS GS2 未做，風險登記 R9）：signaling 的完整性邊界
 *   是你自己的 Firebase auth/rules，不是密碼學。
 *
 * 需自備 Firebase 專案與對應 rules／索引，見 docs/SDK-QUICKSTART.md。
 */
export function createFirestoreSignaling(): SignalingFactory {
  return (roomId, channelLabel) =>
    createLazySignalingTransport(async () => {
      // 動態載入：主入口 `nerilo` 的 eager 圖不得靜態帶進 firebase（qa:sdk-isolation 硬閘）。
      const m = await import('../core/p2p/SignalingTransport');
      return new m.RoomSignalingTransport(roomId, channelLabel);
    });
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
