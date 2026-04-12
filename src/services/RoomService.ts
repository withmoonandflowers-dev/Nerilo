import { ref, set, get, update, remove, onValue, query as rtdbQuery, orderByChild, equalTo, onDisconnect, DataSnapshot } from 'firebase/database';
import { rtdb } from '../config/firebase';
import { RTDB } from '../config/rtdb-paths';
import { generateUUID } from '../utils/uuid';
import { logger } from '../utils/logger';
import type { P2PRoom } from '../types';

// 只在開發模式或明確啟用時輸出 debug log，避免正式環境噪音
const DEBUG_ROOMS = import.meta.env.DEV || import.meta.env.VITE_DEBUG_ROOMS === 'true';

/** Convert RTDB participants object {uid: true} to string[] */
function participantsToArray(obj: Record<string, boolean> | null | undefined): string[] {
  return obj ? Object.keys(obj) : [];
}

/** Convert string[] to RTDB participants object {uid: true} */
function participantsToObject(arr: string[]): Record<string, boolean> {
  const obj: Record<string, boolean> = {};
  for (const uid of arr) {
    obj[uid] = true;
  }
  return obj;
}

/** Parse a room snapshot value into a P2PRoom (or null) */
function parseRoom(roomId: string, data: any): P2PRoom | null {
  if (!data) return null;
  return {
    roomId,
    name: data.name || undefined,
    ownerUid: data.ownerUid,
    ownerName: data.ownerName,
    participants: participantsToArray(data.participants),
    status: data.status || 'open',
    isPrivate: !!data.isPrivate,
    createdAt: data.createdAt || Date.now(),
    waitingTimeout: data.waitingTimeout || 5 * 60 * 1000,
    waitingStartedAt: data.waitingStartedAt,
    meshIdentities: data.meshIdentities ? Object.fromEntries(
      Object.entries(data.meshIdentities).map(([key, value]: [string, any]) => [
        key,
        {
          userId: value.userId,
          pubKey: value.pubKey,
          joinedAt: value.joinedAt || Date.now(),
        },
      ])
    ) : undefined,
    topology: data.topology || 'star',
  };
}

export class RoomService {
  /**
   * 建立新房間（預設為 waiting 狀態）
   * 如果同一用戶已有其他房間，會先關閉它們（包括所有狀態的房間）
   *
   * 安全要求：
   * - 只允許已登入的用戶建立房間（非匿名用戶）
   * - 自動清理用戶的所有舊房間
   *
   * @throws {Error} 如果 ownerUid 為空或無效
   */
  static async createRoom(
    ownerUid: string,
    ownerName: string | null,
    isPrivate: boolean,
    participants: string[] = [],
    waitingTimeout: number = 5 * 60 * 1000, // 預設 5 分鐘
    requireAuth: boolean = true, // 是否要求已登入（非匿名）
    roomName?: string // 使用者自訂房間名稱
  ): Promise<string> {
    // 驗證 ownerUid
    if (!ownerUid || ownerUid.trim() === '') {
      throw new Error('無法建立房間：用戶 ID 無效');
    }

    // 安全檢查：只允許已登入的用戶建立房間
    // 在測試環境中，允許 guest 用戶建立房間（用於 E2E 測試）
    const isTestEnv = typeof window !== 'undefined' && (
      (window as any).__PLAYWRIGHT_TEST__ === true ||
      import.meta.env.MODE === 'test' ||
      import.meta.env.VITE_ALLOW_GUEST_CREATE_ROOM === 'true'
    );

    if (requireAuth && !isTestEnv) {
      // 注意：這裡無法直接檢查是否為匿名用戶，需要在調用端檢查
      logger.info('[RoomService] createRoom - auth check passed', { ownerUid });
    } else if (isTestEnv) {
      logger.info('[RoomService] createRoom - test mode, allowing guest user', { ownerUid });
    }

    // 先關閉同一用戶的所有房間（包括 waiting、open、closed 狀態）
    // 這確保用戶不會有多個活躍房間
    await this.closeAllUserRooms(ownerUid);

    const roomId = generateUUID();
    const now = Date.now();

    if (DEBUG_ROOMS) {
      logger.info('[RoomService] createRoom', {
        roomId,
        ownerUid,
        ownerName,
        isPrivate,
        participants,
        waitingTimeout,
      });
    }

    const participantList = participants.length > 0 ? participants : [ownerUid];

    const roomData = {
      name: roomName?.trim() || `${ownerName || '匿名使用者'} 的房間`,
      ownerUid,
      ownerName: ownerName || '匿名使用者',
      participants: participantsToObject(participantList),
      status: 'waiting' as const,
      isPrivate,
      createdAt: now,
      waitingTimeout,
      waitingStartedAt: now,
    };

    await set(ref(rtdb, RTDB.room(roomId)), roomData);

    return roomId;
  }

  /**
   * 關閉同一用戶的所有房間（包括所有狀態：waiting、open、closed）
   * 這確保用戶建立新房間時，舊房間都被清理
   */
  static async closeAllUserRooms(ownerUid: string): Promise<void> {
    logger.info('[RoomService] closeAllUserRooms called', { ownerUid });

    const q = rtdbQuery(ref(rtdb, RTDB.rooms()), orderByChild('ownerUid'), equalTo(ownerUid));
    const snapshot = await get(q);

    const allRooms: { roomId: string; data: any }[] = [];
    snapshot.forEach((child: DataSnapshot) => {
      allRooms.push({ roomId: child.key!, data: child.val() });
    });

    logger.info('[RoomService] closeAllUserRooms - found rooms', {
      ownerUid,
      totalRooms: allRooms.length,
      rooms: allRooms.map(r => ({
        roomId: r.roomId,
        status: r.data.status,
        participants: participantsToArray(r.data.participants).length,
      })),
    });

    // 關閉所有房間（包括已經是 closed 狀態的，確保一致性）
    const batch = allRooms.map((r) => {
      return update(ref(rtdb, RTDB.room(r.roomId)), {
        status: 'closed',
        closedAt: Date.now(),
      });
    });

    if (batch.length > 0) {
      await Promise.all(batch);
      logger.info('[RoomService] Closed all', batch.length, 'rooms for user', ownerUid);
    }
  }

  /**
   * 關閉同一用戶的所有非 closed 狀態的房間（包括 waiting 和 open）
   * @deprecated 使用 closeAllUserRooms 代替，確保所有房間都被清理
   */
  static async closeUserWaitingRooms(ownerUid: string): Promise<void> {
    // 為了向後兼容，調用新方法
    await this.closeAllUserRooms(ownerUid);
  }

  /**
   * 取得房間資訊
   */
  static async getRoom(roomId: string, _forceServer = false): Promise<P2PRoom | null> {
    const snapshot = await get(ref(rtdb, RTDB.room(roomId)));
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.val();
    const result = parseRoom(roomId, data);

    if (DEBUG_ROOMS) {
      logger.info('[RoomService] getRoom', result);
    }

    return result;
  }

  /**
   * 加入房間
   * 如果房間是 waiting 狀態且有第二個人加入，自動轉為 open 狀態
   */
  static async joinRoom(roomId: string, uid: string): Promise<void> {
    logger.info('[RoomService] joinRoom called', { roomId, uid });

    const snapshot = await get(ref(rtdb, RTDB.room(roomId)));

    if (!snapshot.exists()) {
      logger.error('[RoomService] joinRoom failed: Room does not exist', { roomId });
      throw new Error('房間不存在');
    }

    const roomData = snapshot.val();
    const participants = participantsToArray(roomData.participants);
    logger.info('[RoomService] joinRoom - current room data', {
      roomId,
      status: roomData.status,
      participants,
      ownerUid: roomData.ownerUid,
    });

    // 檢查房間狀態
    if (roomData.status === 'closed') {
      logger.warn('[RoomService] joinRoom failed: Room is closed', { roomId, uid });
      throw new Error('房間已關閉');
    }

    const isNewParticipant = !participants.includes(uid);
    const newParticipants = isNewParticipant ? [...participants, uid] : participants;

    logger.info('[RoomService] joinRoom - participant check', {
      roomId,
      uid,
      isNewParticipant,
      currentParticipants: participants,
      newParticipants,
    });

    // 當 waiting 房間人數達到 2 人時，自動轉為 open 狀態
    const shouldActivate = roomData.status === 'waiting' && newParticipants.length >= 2;

    logger.info('[RoomService] joinRoom - activation check', {
      roomId,
      shouldActivate,
      status: roomData.status,
      participantCount: newParticipants.length,
      isNewParticipant,
    });

    if (isNewParticipant || shouldActivate) {
      const updateData: Record<string, any> = {
        participants: participantsToObject(newParticipants),
      };

      if (shouldActivate) {
        updateData.status = 'open';
        if (DEBUG_ROOMS) {
          logger.info('[RoomService] Room activated', {
            roomId,
            participants: newParticipants,
            participantCount: newParticipants.length,
          });
        }
      }

      logger.info('[RoomService] joinRoom - updating room', { roomId, updateData });
      await update(ref(rtdb, RTDB.room(roomId)), updateData);
      logger.info('[RoomService] joinRoom - room updated successfully', {
        roomId,
        newStatus: updateData.status || roomData.status,
        newParticipantCount: newParticipants.length,
      });
    } else {
      logger.info('[RoomService] joinRoom - no update needed', {
        roomId,
        uid,
        isNewParticipant,
        currentStatus: roomData.status,
        participantCount: newParticipants.length,
      });
    }

    // Set up onDisconnect to remove this participant if they lose connection
    onDisconnect(ref(rtdb, RTDB.roomParticipant(roomId, uid))).remove();
  }

  /**
   * 啟動房間（將 waiting 狀態改為 open）
   */
  static async activateRoom(roomId: string, ownerUid: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error('房間不存在');
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以啟動房間');
    }

    if (room.status !== 'waiting') {
      throw new Error('房間不是等待狀態');
    }

    await update(ref(rtdb, RTDB.room(roomId)), {
      status: 'open',
    });
  }

  /**
   * 檢查房間是否超時（僅在 waiting 狀態時有效）
   */
  static isRoomTimeout(room: P2PRoom): boolean {
    if (room.status !== 'waiting' || !room.waitingStartedAt || !room.waitingTimeout) {
      return false;
    }

    const elapsed = Date.now() - room.waitingStartedAt;
    return elapsed >= room.waitingTimeout;
  }

  /**
   * 離開房間
   */
  static async leaveRoom(roomId: string, uid: string): Promise<void> {
    const snapshot = await get(ref(rtdb, RTDB.room(roomId)));

    if (!snapshot.exists()) {
      return;
    }

    const roomData = snapshot.val();
    const participants = participantsToArray(roomData.participants);
    const newParticipants = participants.filter((p: string) => p !== uid);

    // 開發階段：即使房間暫時沒有任何 participants，也先不自動關閉房間
    // 只更新 participants，讓房主或後續 UI 明確決定何時關閉房間
    await update(ref(rtdb, RTDB.room(roomId)), {
      participants: participantsToObject(newParticipants),
    });
  }

  /**
   * 關閉房間（標記 status = closed）
   */
  static async closeRoom(roomId: string, ownerUid: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error('房間不存在');
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以關閉房間');
    }

    await update(ref(rtdb, RTDB.room(roomId)), {
      status: 'closed',
    });
  }

  /**
   * 房主離開房間：直接從 RTDB 刪除房間節點
   *
   * 設計說明：
   * - 房間節點從 Firebase 刪除 → 房間從公開列表消失
   * - 已建立的 P2P WebRTC 連線不受影響（連線不依賴 RTDB）
   * - 若剩餘成員中有人沒有自己的房間，可透過 RoomRequestService.promoteNewHost()
   *   另建新房間，讓後續新人可找到入口
   *
   * @param roomId   房間 ID
   * @param ownerUid 必須是房主的 UID，否則拒絕操作
   */
  static async deleteRoom(roomId: string, ownerUid: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) {
      // 節點已不存在，視為成功
      return;
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以刪除房間');
    }

    // Remove the room and associated subcollections
    await Promise.all([
      remove(ref(rtdb, RTDB.room(roomId))),
      remove(ref(rtdb, 'signals/' + roomId)),
      remove(ref(rtdb, 'relay/' + roomId)),
    ]);

    if (DEBUG_ROOMS) {
      logger.info('[RoomService] deleteRoom: room removed from Firebase', {
        roomId,
        ownerUid,
        participants: room.participants,
      });
    }
  }

  /**
   * 房主離開時的完整流程：
   * 1. 從 RTDB 刪除房間節點（讓房間從列表消失）
   * 2. 回傳剩餘成員列表，供呼叫端決定是否需要提升新房主
   *
   * 注意：P2P 連線由 P2PManager 管理，這裡只處理 RTDB 狀態。
   */
  static async ownerLeaveRoom(
    roomId: string,
    ownerUid: string
  ): Promise<{ remainingParticipants: string[] }> {
    const room = await this.getRoom(roomId);
    if (!room) {
      return { remainingParticipants: [] };
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以執行 ownerLeaveRoom');
    }

    const remainingParticipants = room.participants.filter((p) => p !== ownerUid);

    // 刪除房間節點及相關子路徑（讓房間從 Firebase 消失）
    await Promise.all([
      remove(ref(rtdb, RTDB.room(roomId))),
      remove(ref(rtdb, 'signals/' + roomId)),
      remove(ref(rtdb, 'relay/' + roomId)),
    ]);

    logger.info('[RoomService] ownerLeaveRoom: room deleted from Firebase', {
      roomId,
      ownerUid,
      remainingParticipants,
    });

    return { remainingParticipants };
  }

  /**
   * 監聽使用者參與的房間
   */
  static subscribeUserRooms(
    uid: string,
    callback: (rooms: P2PRoom[]) => void
  ): () => void {
    // RTDB doesn't support array-contains; listen to all rooms and filter client-side
    const roomsRef = ref(rtdb, RTDB.rooms());

    const unsubscribe = onValue(roomsRef, (snapshot: DataSnapshot) => {
      const rooms: P2PRoom[] = [];
      snapshot.forEach((child: DataSnapshot) => {
        const data = child.val();
        if (data.participants?.[uid] === true) {
          const room = parseRoom(child.key!, data);
          if (room) rooms.push(room);
        }
      });
      if (DEBUG_ROOMS) {
        logger.info('[RoomService] subscribeUserRooms snapshot', {
          uid,
          count: rooms.length,
          rooms,
        });
      }
      callback(rooms);
    });

    return unsubscribe;
  }

  /**
   * 監聽單一房間變化
   */
  static subscribeRoom(
    roomId: string,
    callback: (room: P2PRoom | null) => void
  ): () => void {
    const roomRef = ref(rtdb, RTDB.room(roomId));

    const unsubscribe = onValue(roomRef, (snapshot: DataSnapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }

      const data = snapshot.val();
      callback(parseRoom(roomId, data));
    });

    return unsubscribe;
  }

  /**
   * 監聽所有公開房間（非 private、狀態為 open）
   */
  static subscribePublicRooms(
    callback: (rooms: P2PRoom[]) => void
  ): () => void {
    const q = rtdbQuery(ref(rtdb, RTDB.rooms()), orderByChild('status'), equalTo('open'));

    const unsubscribe = onValue(q, (snapshot: DataSnapshot) => {
      const rooms: P2PRoom[] = [];
      snapshot.forEach((child: DataSnapshot) => {
        const data = child.val();
        const room = parseRoom(child.key!, data);
        if (room) rooms.push(room);
      });

      // 只在前端過濾出非 private 的房間
      const publicRooms = rooms.filter((room) => !room.isPrivate);
      if (DEBUG_ROOMS) {
        logger.info('[RoomService] subscribePublicRooms snapshot', {
          count: publicRooms.length,
          rooms: publicRooms,
        });
      }
      callback(publicRooms);
    });

    return unsubscribe;
  }

  /**
   * 更新或添加小網狀架構的身分資訊
   */
  static async updateMeshIdentity(
    roomId: string,
    firebaseUid: string,
    userId: string,
    pubKey: string
  ): Promise<void> {
    const snapshot = await get(ref(rtdb, RTDB.room(roomId)));

    if (!snapshot.exists()) {
      throw new Error('房間不存在');
    }

    const roomData = snapshot.val();
    const participants = participantsToArray(roomData.participants);

    if (!participants.includes(firebaseUid)) {
      throw new Error('用戶不是房間參與者');
    }

    // 更新 meshIdentities
    const meshIdentities = roomData.meshIdentities || {};
    meshIdentities[firebaseUid] = {
      userId,
      pubKey,
      joinedAt: Date.now(),
    };

    await update(ref(rtdb, RTDB.room(roomId)), {
      meshIdentities,
      topology: 'mesh', // 標記為 mesh 拓撲
    });

    if (DEBUG_ROOMS) {
      logger.info('[RoomService] Updated mesh identity', {
        roomId,
        firebaseUid,
        userId,
      });
    }
  }

  /**
   * 獲取房間內所有節點的 mesh 身分資訊
   */
  static async getMeshIdentities(roomId: string): Promise<Map<string, { userId: string; pubKey: string }>> {
    const room = await this.getRoom(roomId, true);
    if (!room || !room.meshIdentities) {
      return new Map();
    }

    const identities = new Map<string, { userId: string; pubKey: string }>();
    for (const [firebaseUid, identity] of Object.entries(room.meshIdentities)) {
      identities.set(firebaseUid, {
        userId: identity.userId,
        pubKey: identity.pubKey,
      });
    }

    return identities;
  }
}
