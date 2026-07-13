/**
 * 將靜態 RoomService 適配為 IRoomService 介面，供 Context 注入與測試替換。
 */
import { RoomService } from './RoomService';
import type { IRoomService } from '../ports';

export const roomServiceAdapter: IRoomService = {
  createRoom: (ownerUid, ownerName, isPrivate, participants, waitingTimeout, requireAuth, roomName) =>
    RoomService.createRoom(ownerUid, ownerName, isPrivate, participants ?? [], waitingTimeout, requireAuth, roomName),

  closeAllUserRooms: (ownerUid) => RoomService.closeAllUserRooms(ownerUid),

  getRoom: (roomId, forceServer) => RoomService.getRoom(roomId, forceServer),
  isRoomTimeout: (room) => RoomService.isRoomTimeout(room),

  joinRoom: (roomId, uid) => RoomService.joinRoom(roomId, uid),
  leaveRoom: (roomId, uid) => RoomService.leaveRoom(roomId, uid),
  closeRoom: (roomId, ownerUid) => RoomService.closeRoom(roomId, ownerUid),
  activateRoom: (roomId, ownerUid) => RoomService.activateRoom(roomId, ownerUid),

  subscribeRoom: (roomId, callback) => RoomService.subscribeRoom(roomId, callback),
  subscribeUserRooms: (uid, callback) => RoomService.subscribeUserRooms(uid, callback),
  getPublicRooms: () => RoomService.getPublicRooms(),

  updateMeshIdentity: (roomId, firebaseUid, userId, pubKey) =>
    RoomService.updateMeshIdentity(roomId, firebaseUid, userId, pubKey),
  getMeshIdentities: (roomId) => RoomService.getMeshIdentities(roomId),
};
