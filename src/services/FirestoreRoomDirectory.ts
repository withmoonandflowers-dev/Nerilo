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

  async registerIdentity(entry: { userId: string; pubKey: string; ecdhPubKey?: string }): Promise<void> {
    await RoomService.updateMeshIdentity(this.roomId, this.localUid, entry.userId, entry.pubKey, entry.ecdhPubKey);
  }

  watchIdentities(onChange: (snapshot: RoomSnapshot) => void): () => void {
    const roomRef = doc(db, 'p2pRooms', this.roomId);
    return onSnapshot(
      roomRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as {
          meshIdentities?: Record<string, DirectoryIdentity>;
          participants?: string[];
        };
        onChange({ meshIdentities: data.meshIdentities ?? {}, participants: data.participants ?? [] });
      },
      (error) => {
        logger.warn('[FirestoreRoomDirectory] watchIdentities error', { error });
      }
    );
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
