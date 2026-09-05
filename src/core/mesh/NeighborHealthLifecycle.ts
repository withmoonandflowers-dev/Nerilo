/**
 * Mesh 鄰居的心跳與行為評分生命週期，從 MeshGossipManager 拆出。
 *
 * 兩套狀態必須在同一個鄰居掃描週期註冊與清除，避免 RTT 與 gossip 評分
 * 對不同的 peer 集合累積。PeerScoring 的 timer 也由本模組統一啟停。
 */
import type { HeartbeatService } from './HeartbeatService';
import { PeerScoring } from '../relay/PeerScoring';

export function createActivePeerScoring(): PeerScoring {
  const scoring = new PeerScoring();
  // 啟動既有 60 秒衰減。否則暫時性的驗簽失敗會永久累積 invalid penalty，
  // 即使後續長期正常也無法自行恢復；擁有者 cleanup() 以 destroy() 停止 timer。
  scoring.start();
  return scoring;
}

export function registerNeighborHealth(
  heartbeat: HeartbeatService | null,
  scoring: PeerScoring | null,
  peerId: string
): void {
  heartbeat?.addPeer(peerId);
  scoring?.addPeer(peerId);
}

export function pruneNeighborHealth(
  heartbeat: HeartbeatService | null,
  scoring: PeerScoring | null,
  liveIds: ReadonlySet<string>
): void {
  for (const info of heartbeat?.getAllPeerInfo() ?? []) {
    if (!liveIds.has(info.peerId)) heartbeat?.removePeer(info.peerId);
  }
  for (const score of scoring?.getRankedPeers() ?? []) {
    if (!liveIds.has(score.nodeId)) scoring?.removePeer(score.nodeId);
  }
}
