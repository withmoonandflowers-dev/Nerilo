/**
 * 房間服務 Port（介面）
 * 實作可由 Firestore、Mock 等提供，利於解耦與測試。
 */
import type { P2PRoom } from '../types';

export interface IRoomService {
  createRoom(
    ownerUid: string,
    ownerName: string | null,
    isPrivate: boolean,
    participants?: string[],
    waitingTimeout?: number,
    requireAuth?: boolean,
    roomName?: string
  ): Promise<string>;

  closeAllUserRooms(ownerUid: string): Promise<void>;

  getRoom(roomId: string, forceServer?: boolean): Promise<P2PRoom | null>;

  /** 是否已逾時（waiting 房超過 waitingTimeout） */
  isRoomTimeout(room: P2PRoom): boolean;

  joinRoom(roomId: string, uid: string): Promise<void>;
  leaveRoom(roomId: string, uid: string): Promise<void>;
  closeRoom(roomId: string, ownerUid: string): Promise<void>;
  activateRoom(roomId: string, ownerUid: string): Promise<void>;

  subscribeRoom(roomId: string, callback: (room: P2PRoom | null) => void): () => void;
  subscribeUserRooms(uid: string, callback: (rooms: P2PRoom[]) => void): () => void;
  /** 一次性讀公開房（伺服器端過濾 + limit；讀取衛生，見 RoomService.getPublicRooms） */
  getPublicRooms(): Promise<P2PRoom[]>;

  updateMeshIdentity(
    roomId: string,
    firebaseUid: string,
    userId: string,
    pubKey: string
  ): Promise<void>;
  getMeshIdentities(roomId: string): Promise<Map<string, { userId: string; pubKey: string }>>;
}
