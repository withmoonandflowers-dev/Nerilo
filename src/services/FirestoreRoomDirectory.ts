import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../config/firebase';
import { RoomService } from './RoomService';
import { logger } from '../utils/logger';
import type { IRoomDirectory, RoomSnapshot, DirectoryIdentity } from '../ports/IRoomDirectory';

/**
 * 預設 directory：Firestore p2pRooms/{roomId}.meshIdentities（與 P2b 之前直接內嵌在
 * MeshTopologyManager/MeshGossipManager 的邏輯逐字一致——只是搬到這道 adapter 後面）。
 */
export class FirestoreRoomDirectory implements IRoomDirectory {
  constructor(
    private readonly roomId: string,
    private readonly localUid: string
  ) {}

  async registerIdentity(entry: {
    userId: string;
    pubKey: string;
    ecdhPubKey?: string;
    introducedBy?: string;
  }): Promise<void> {
    await RoomService.updateMeshIdentity(
      this.roomId,
      this.localUid,
      entry.userId,
      entry.pubKey,
      entry.ecdhPubKey,
      entry.introducedBy
    );
  }

  watchIdentities(onChange: (snapshot: RoomSnapshot) => void): () => void {
    const roomRef = doc(db, 'p2pRooms', this.roomId);
    // A6：這是 mesh 唯一的名冊 push 通道（成員發現／rejoin 偵測／人數）。此前一次
    // 暫時性 onSnapshot error 就會讓 listener 被永久移除、整條靜止且 UI 無感。
    // 改為有界退避自動重訂閱：成功快照即重置退避；permission-denied 這類永久錯誤
    // 由 MAX_RETRIES 上界收斂，不會無限重試。
    const MAX_RETRIES = 5;
    let unsub: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;

    const subscribe = (): void => {
      if (stopped) return;
      unsub = onSnapshot(
        roomRef,
        (snap) => {
          attempts = 0; // 收到快照＝連線健康，重置退避
          if (!snap.exists()) return;
          const data = snap.data() as {
            meshIdentities?: Record<string, DirectoryIdentity>;
            participants?: string[];
          };
          onChange({ meshIdentities: data.meshIdentities ?? {}, participants: data.participants ?? [] });
        },
        (error) => {
          if (unsub) { unsub(); unsub = null; }
          if (stopped || attempts >= MAX_RETRIES) {
            logger.warn('[FirestoreRoomDirectory] watchIdentities error（不再重訂閱）', {
              roomId: this.roomId, attempts, error,
            });
            return;
          }
          const delay = Math.min(1000 * 2 ** attempts, 15000);
          attempts++;
          logger.warn('[FirestoreRoomDirectory] watchIdentities error，將重訂閱', {
            roomId: this.roomId, attempt: attempts, delay, error,
          });
          retryTimer = setTimeout(subscribe, delay);
        }
      );
    };

    subscribe();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (unsub) unsub();
    };
  }

  async getSnapshot(preferCached = false): Promise<RoomSnapshot> {
    // preferCached＝true → 允許快取讀（forceServer=false）；預設要最新（forceServer=true）。
    const room = await RoomService.getRoom(this.roomId, !preferCached);
    return {
      meshIdentities: (room?.meshIdentities ?? {}) as Record<string, DirectoryIdentity>,
      participants: room?.participants ?? [],
    };
  }
}
