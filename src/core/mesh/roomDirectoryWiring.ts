/**
 * roomDirectoryWiring — 把房間目錄 gossip（ADR-0027）掛上暖 mesh 連線（Spec 005 T5）。
 *
 * RoomDirectoryGossip 是純協議（簽章廣告＋快取＋attach 對稱交換），原設計掛 relay bus；
 * 本膠水把 MeshConnection 的 roomdir 啞管道適配成它的 RoomDirBus——於是**已連上的
 * mesh 本身就是目錄傳播網**：新 peer 經介紹人連上任一人，attach 即交換雙方快取，
 * 不經任何伺服器就知道網路上有哪些房（後續 warm 發現/去中心化大廳的地基）。
 *
 * 純膠水、可注入假連線決定性測試。
 */
import {
  attachRoomDirectory,
  type RoomAdvert,
  type RoomAdvertCache,
} from '../relay/RoomDirectoryGossip';
import type { GossipRelayEnvelope } from './MeshConnection';

/** 膠水需要的最小連線面（MeshConnection 結構性符合；測試用假物件）。 */
export interface RoomDirCapableConnection {
  onRoomDir(listener: (env: GossipRelayEnvelope) => void): () => void;
  sendRoomDir(env: GossipRelayEnvelope): Promise<void>;
}

/**
 * 在一條連線上掛目錄交換：立即 announce、驗簽入快取、首聞回播、週期重播。
 * 回傳 detach（連線換代/離場時務必呼叫，否則週期 timer 洩漏）。
 */
export function wireRoomDirectoryOnConnection(
  conn: RoomDirCapableConnection,
  opts: {
    cache: RoomAdvertCache;
    localUid: string;
    getLocalAdverts: () => Promise<RoomAdvert[]>;
    announceIntervalMs?: number;
  }
): () => void {
  return attachRoomDirectory({
    bus: {
      subscribe: (_ns, handler) => conn.onRoomDir((env) => void handler(env)),
      send: (env) => conn.sendRoomDir(env as GossipRelayEnvelope),
    },
    cache: opts.cache,
    localUid: opts.localUid,
    getLocalAdverts: opts.getLocalAdverts,
    ...(opts.announceIntervalMs !== undefined ? { announceIntervalMs: opts.announceIntervalMs } : {}),
  });
}
