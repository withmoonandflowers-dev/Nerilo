import { collection, doc, setDoc, getDoc, getDocFromServer, getDocs, updateDoc, deleteDoc, onSnapshot, query, where, limit, Timestamp, runTransaction, increment } from 'firebase/firestore';
import { db } from '../config/firebase';
import { generateUUID } from '../utils/uuid';
import { logger } from '../utils/logger';
import type { P2PRoom, RoomStatus, RoomCapability, RoomMemberState } from '../types';

/** Firestore meshIdentity 文件的原始欄位型別（joinedAt 可能為 Timestamp） */
interface FirestoreMeshIdentity {
  userId: string;
  pubKey: string;
  ecdhPubKey?: string;
  joinedAt: { toMillis?: () => number } | number;
}

// 只在開發模式或明確啟用時輸出 debug log，避免正式環境噪音
const DEBUG_ROOMS = import.meta.env.DEV || import.meta.env.VITE_DEBUG_ROOMS === 'true';

export class RoomService {
  /**
   * 持久聊天室 TTL（2026-07-05 產品決策）：open 房不再 30 分鐘過期——
   * 聊天室持續存在直到「所有成員都刪除」。以遠期 ttlExpireAt 實現：
   * 與殭屍房過濾（ttlExpireAt > now）及 Firestore 原生 TTL 政策相容，
   * 不需改任何查詢。waiting 房仍 5 分鐘過期（避免棄置房堆積）。
   */
  static readonly PERSISTENT_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

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
    roomName?: string // 使用者自訂房間名稱（選填）
  ): Promise<string> {
    // 驗證 ownerUid
    if (!ownerUid || ownerUid.trim() === '') {
      throw new Error('無法建立房間：用戶 ID 無效');
    }

    // 安全檢查：只允許已登入的用戶建立房間
    // 在測試環境中，允許 guest 用戶建立房間（用於 E2E 測試）
    const isTestEnv = typeof window !== 'undefined' && (
      (window as unknown as Record<string, unknown>).__PLAYWRIGHT_TEST__ === true ||
      import.meta.env.MODE === 'test' ||
      import.meta.env.VITE_ALLOW_GUEST_CREATE_ROOM === 'true'
    );
    
    if (requireAuth && !isTestEnv) {
      // 注意：這裡無法直接檢查是否為匿名用戶，需要在調用端檢查
      // 但我們可以在 Firestore 規則中加強驗證
      logger.info('[RoomService] createRoom - auth check passed', { ownerUid });
    } else if (isTestEnv) {
      logger.info('[RoomService] createRoom - test mode, allowing guest user', { ownerUid });
    }

    // 持久聊天室（2026-07-05 產品決策）：使用者可以同時擁有多個聊天室，
    // 建新房「不再」關閉既有 open 房；只回收自己棄置中的 waiting 大廳
    // （避免等待房堆積佔據列表）。
    await this.closeAbandonedWaitingRooms(ownerUid);

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
    // TTL: waiting rooms expire in 5 min, open rooms in 30 min
    const WAITING_TTL_MS = 5 * 60 * 1000;

    // 房名清理：去頭尾空白、上限 50 字；空字串視為未命名（不寫入該欄位）
    const cleanRoomName = roomName?.trim().slice(0, 50);

    const roomData: Omit<P2PRoom, 'roomId'> = {
      ownerUid,
      ownerName: ownerName || '匿名使用者',
      participants: participants.length > 0 ? participants : [ownerUid],
      status: 'waiting',
      isPrivate,
      createdAt: now,
      waitingTimeout,
      waitingStartedAt: now,
      lastActiveAt: now,
      ttlExpireAt: now + WAITING_TTL_MS,
      ...(cleanRoomName ? { roomName: cleanRoomName } : {}),
    };

    const firestoreData: Record<string, unknown> = {
      ...roomData,
      createdAt: Timestamp.fromMillis(roomData.createdAt),
      waitingStartedAt: Timestamp.fromMillis(roomData.waitingStartedAt!),
      // ttlExpireAt 寫成 Timestamp 供 Firestore 原生 TTL policy 自動清除
      // （policy 只認 Timestamp 型別）。domain model 仍以 number 表示。
      ttlExpireAt: Timestamp.fromMillis(roomData.ttlExpireAt!),
    };

    await setDoc(doc(db, 'p2pRooms', roomId), firestoreData);

    return roomId;
  }

  /**
   * 關閉同一用戶的所有房間（包括所有狀態：waiting、open、closed）
   * 這確保用戶建立新房間時，舊房間都被清理
   */
  /** 只關閉自己「等待中」的房間（棄置大廳回收；open 房永不動——持久聊天室） */
  static async closeAbandonedWaitingRooms(ownerUid: string): Promise<void> {
    const roomsRef = collection(db, 'p2pRooms');
    const q = query(
      roomsRef,
      where('ownerUid', '==', ownerUid),
      where('status', '==', 'waiting')
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return;
    await Promise.allSettled(
      snapshot.docs.map((d) =>
        updateDoc(doc(db, 'p2pRooms', d.id), {
          status: 'closed',
          closedAt: Timestamp.fromMillis(Date.now()),
        })
      )
    );
    logger.info('[RoomService] closed abandoned waiting rooms', {
      ownerUid,
      count: snapshot.size,
    });
  }

  static async closeAllUserRooms(ownerUid: string): Promise<void> {
    logger.info('[RoomService] closeAllUserRooms called', { ownerUid });
    
    const roomsRef = collection(db, 'p2pRooms');
    // 查詢該用戶的所有房間（不限狀態）
    const q = query(
      roomsRef,
      where('ownerUid', '==', ownerUid)
    );

    const snapshot = await getDocs(q);
    const allRooms = snapshot.docs.map((docSnapshot) => ({
      roomId: docSnapshot.id,
      data: docSnapshot.data(),
    }));

    logger.info('[RoomService] closeAllUserRooms - found rooms', {
      ownerUid,
      totalRooms: allRooms.length,
      rooms: allRooms.map(r => ({ 
        roomId: r.roomId, 
        status: r.data.status,
        participants: r.data.participants?.length || 0 
      })),
    });

    // 關閉所有房間（包括已經是 closed 狀態的，確保一致性）
    const batch = allRooms.map((r) => {
      const docRef = doc(db, 'p2pRooms', r.roomId);
      return updateDoc(docRef, { 
        status: 'closed',
        closedAt: Timestamp.fromMillis(Date.now()),
      });
    });

    if (batch.length > 0) {
      // 使用 allSettled 確保單一房間失敗不會阻斷其他房間的關閉 (#33)
      const results = await Promise.allSettled(batch);
      const failed = results
        .map((r, i) => r.status === 'rejected' ? allRooms[i]?.roomId : null)
        .filter(Boolean);
      if (failed.length > 0) {
        logger.error('[RoomService] Failed to close some rooms', { ownerUid, failed });
      }
      logger.info('[RoomService] Closed rooms for user', {
        ownerUid, total: batch.length, failed: failed.length,
      });
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
  static async getRoom(roomId: string, forceServer = false): Promise<P2PRoom | null> {
    const roomDoc = doc(db, 'p2pRooms', roomId);
    const roomSnapshot = forceServer 
      ? await getDocFromServer(roomDoc)
      : await getDoc(roomDoc);
    if (!roomSnapshot.exists()) {
      return null;
    }

    const data = roomSnapshot.data();
    const result: P2PRoom = {
      roomId: roomSnapshot.id,
      ownerUid: data.ownerUid,
      ownerName: data.ownerName,
      participants: data.participants || [],
      status: data.status || 'open',
      isPrivate: !!data.isPrivate,
      createdAt: data.createdAt?.toMillis() || Date.now(),
      waitingTimeout: data.waitingTimeout || 5 * 60 * 1000,
      waitingStartedAt: data.waitingStartedAt?.toMillis(),
      meshIdentities: data.meshIdentities ? Object.fromEntries(
        (Object.entries(data.meshIdentities) as [string, FirestoreMeshIdentity][]).map(([key, value]) => [
          key,
          {
            userId: value.userId,
            pubKey: value.pubKey,
            ...(value.ecdhPubKey ? { ecdhPubKey: value.ecdhPubKey } : {}),
            joinedAt: (typeof value.joinedAt === 'object' && value.joinedAt?.toMillis?.()) || (typeof value.joinedAt === 'number' ? value.joinedAt : Date.now()),
          },
        ])
      ) : undefined,
      topology: data.topology || 'star',
      hostMigrationEpoch: data.hostMigrationEpoch ?? 0,
      version: data.version ?? 0,
      previousRoomId: data.previousRoomId ?? null,
      lineageRootRoomId: data.lineageRootRoomId ?? null,
      capabilityHint: data.capabilityHint,
    };

    if (DEBUG_ROOMS) {
      logger.info('[RoomService] getRoom', result);
    }

    return result;
  }

  /**
   * 加入房間（使用 Firestore transaction，避免並發 race condition）
   *
   * 安全保證：
   * - 原子性：participants 更新與 status 變更在同一 transaction 內完成
   * - 防重複：若 uid 已在 participants 中則不做任何修改
   * - 狀態保護：closed / migrating 房間拒絕加入
   * - 自動激活：waiting 房間滿 2 人時自動轉為 open
   */
  static async joinRoom(roomId: string, uid: string): Promise<void> {
    logger.info('[RoomService] joinRoom called', { roomId, uid });

    // Firebase SDK on the REST transport does not auto-retry 'failed-precondition'
    // (which is what Firestore returns when the updateTime precondition on a write
    // fails, i.e. another client wrote to the doc between our read and commit).
    // gRPC transport returns 'aborted' for the same situation and the SDK retries;
    // here we add our own retry to cover both transports.
    const MAX_ATTEMPTS = 4;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this._joinRoomTransaction(db, roomId, uid);
        return;
      } catch (err: unknown) {
        const code: string = (err as { code?: string })?.code ?? '';
        const isRetryable = code === 'failed-precondition' || code === 'aborted';
        if (isRetryable && attempt < MAX_ATTEMPTS) {
          const delayMs = 150 * attempt;
          logger.warn('[RoomService] joinRoom transaction conflict, retrying', {
            roomId, uid, attempt, code, delayMs,
          });
          await new Promise(r => setTimeout(r, delayMs));
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** Inner transaction logic – extracted so the retry loop stays clean. */
  private static async _joinRoomTransaction(
    db: Parameters<typeof runTransaction>[0],
    roomId: string,
    uid: string
  ): Promise<void> {
    await runTransaction(db, async (transaction) => {
      const roomDocRef = doc(db, 'p2pRooms', roomId);
      const roomSnap = await transaction.get(roomDocRef);

      if (!roomSnap.exists()) {
        logger.error('[RoomService] joinRoom failed: Room does not exist', { roomId });
        throw new Error('房間不存在');
      }

      const roomData = roomSnap.data();

      // 拒絕加入已關閉或遷移中的房間（提供清晰的狀態錯誤碼）
      if (roomData.status === 'closed') {
        logger.warn('[RoomService] joinRoom failed: Room is closed', { roomId, uid });
        throw Object.assign(
          new Error('房間已關閉，請返回房間列表'),
          { code: 'room-closed', roomStatus: 'closed' }
        );
      }
      if (roomData.status === 'migrating') {
        logger.warn('[RoomService] joinRoom failed: Room is migrating', { roomId, uid });
        throw Object.assign(
          new Error('房間正在遷移主機中，請稍後重試'),
          { code: 'room-migrating', roomStatus: 'migrating' }
        );
      }

      const participants: string[] = roomData.participants || [];

      // 若已在房間內，不做任何修改（Transaction 仍需 commit 但無寫入）
      if (participants.includes(uid)) {
        logger.info('[RoomService] joinRoom - already a participant, no-op', { roomId, uid });
        return;
      }

      // 人數上限（與 firestore.rules 的 participantsWithinCap 同值）：
      // 先在 client 端給清晰錯誤，rules 是最終防線
      const MAX_PARTICIPANTS = 5;
      if (participants.length >= MAX_PARTICIPANTS) {
        logger.warn('[RoomService] joinRoom failed: Room is full', { roomId, uid });
        throw Object.assign(
          new Error(`房間已滿（上限 ${MAX_PARTICIPANTS} 人）`),
          { code: 'room-full', roomStatus: roomData.status }
        );
      }

      const newParticipants = [...participants, uid];
      // 當 waiting 房間滿 2 人時，自動轉為 open
      const shouldActivate = roomData.status === 'waiting' && newParticipants.length >= 2;

      const OPEN_TTL_MS = RoomService.PERSISTENT_TTL_MS; // 持久聊天室（2026-07-05 產品決策）
      const now = Date.now();

      const updateData: Record<string, unknown> = {
        participants: newParticipants,
        participantCount: newParticipants.length,
        lastActiveAt: now,
        ttlExpireAt: Timestamp.fromMillis(now + OPEN_TTL_MS),
      };

      if (shouldActivate) {
        updateData.status = 'open';
      }

      transaction.update(roomDocRef, updateData);

      logger.info('[RoomService] joinRoom - transaction committed', {
        roomId,
        uid,
        newStatus: shouldActivate ? 'open' : roomData.status,
        newParticipantCount: newParticipants.length,
      });
    });
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

    await updateDoc(doc(db, 'p2pRooms', roomId), {
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
   *
   * 使用 Firestore Transaction 確保原子性，並對 failed-precondition / aborted 做重試，
   * 避免 React StrictMode cleanup 與 joinRoom 並發寫入時發生衝突。
   */
  static async leaveRoom(roomId: string, uid: string): Promise<void> {
    logger.info('[RoomService] leaveRoom called', { roomId, uid });

    const MAX_ATTEMPTS = 4;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await runTransaction(db, async (transaction) => {
          const roomDocRef = doc(db, 'p2pRooms', roomId);
          const roomSnap = await transaction.get(roomDocRef);

          if (!roomSnap.exists()) {
            // 房間已不存在，視為成功
            return;
          }

          const roomData = roomSnap.data();
          const participants: string[] = roomData.participants || [];
          const newParticipants = participants.filter((p: string) => p !== uid);

          // 若用戶本來就不在房間內，不需要寫入（避免空 commit 觸發 precondition）
          if (newParticipants.length === participants.length) {
            logger.info('[RoomService] leaveRoom - uid not in participants, no-op', { roomId, uid });
            return;
          }

          // 開發階段：即使房間暫時沒有任何 participants，也先不自動關閉房間
          // 只更新 participants 陣列，讓房主或後續 UI 明確決定何時關閉房間
          const OPEN_TTL_MS = RoomService.PERSISTENT_TTL_MS;
          const now = Date.now();
          transaction.update(roomDocRef, {
            participants: newParticipants,
            participantCount: newParticipants.length,
            lastActiveAt: now,
            ttlExpireAt: Timestamp.fromMillis(now + OPEN_TTL_MS),
          });
        });
        return; // success
      } catch (err: unknown) {
        const code: string = (err as { code?: string })?.code ?? '';
        const isRetryable = code === 'failed-precondition' || code === 'aborted';
        if (isRetryable && attempt < MAX_ATTEMPTS) {
          const delayMs = 150 * attempt;
          logger.warn('[RoomService] leaveRoom transaction conflict, retrying', {
            roomId, uid, attempt, code, delayMs,
          });
          await new Promise(r => setTimeout(r, delayMs));
          lastError = err;
          continue;
        }
        // Non-retryable or exhausted attempts: log but don't throw
        // leaveRoom is best-effort; we don't want to break navigation on failure
        logger.error('[RoomService] leaveRoom failed (non-retryable or exhausted)', {
          roomId, uid, attempt, err,
        });
        return;
      }
    }
    // Exhausted retries — log but swallow to avoid breaking navigation
    logger.error('[RoomService] leaveRoom exhausted retries', { roomId, uid, lastError });
  }

  /**
   * 關閉房間（標記 status = closed，文件仍保留在 Firestore）
   */
  static async closeRoom(roomId: string, ownerUid: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error('房間不存在');
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以關閉房間');
    }

    await updateDoc(doc(db, 'p2pRooms', roomId), {
      status: 'closed',
    });
  }

  /**
   * 房主離開房間：直接從 Firestore 刪除房間文件
   *
   * 設計說明：
   * - 房間文件從 Firebase 刪除 → 房間從公開列表消失
   * - 已建立的 P2P WebRTC 連線不受影響（連線不依賴 Firestore）
   * - 若剩餘成員中有人沒有自己的房間，可透過 RoomRequestService.promoteNewHost()
   *   另建新房間，讓後續新人可找到入口
   *
   * @param roomId   房間 ID
   * @param ownerUid 必須是房主的 UID，否則拒絕操作
   */
  static async deleteRoom(roomId: string, ownerUid: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) {
      // 文件已不存在，視為成功
      return;
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以刪除房間');
    }

    // 先清理子集合（Firestore 刪除父文件不會自動刪除子集合）
    await this.deleteRoomSubcollections(roomId);
    await deleteDoc(doc(db, 'p2pRooms', roomId));

    if (DEBUG_ROOMS) {
      logger.info('[RoomService] deleteRoom: room + subcollections removed from Firebase', {
        roomId,
        ownerUid,
        participants: room.participants,
      });
    }
  }

  /**
   * 清理房間的所有子集合（signals, messages）
   * Firestore 不會在刪除父文件時自動刪除子集合，需要手動逐筆刪除。
   * Best-effort：失敗不影響主流程。
   */
  // ═══════════════════════════════════════════════════════════════════
  // 持久聊天室：成員狀態（2026-07-05 產品決策）
  //
  // 每位成員在 p2pRooms/{roomId}/memberStates/{uid} 有自己的狀態文件
  // （已讀/釘選/軟刪除），規則限制只能寫自己的——避免共享文件搶寫。
  // 「刪除聊天室」是軟刪除（只對自己隱藏）；所有 participants 都軟刪除後，
  // 執行最後一刪的 client 進行真刪除（文件+子集合）。
  // 訊息內容永不上伺服器；列表預覽/未讀比對用本機 IndexedDB + 房間文件的
  // lastActiveAt（僅 metadata，節流寫入）。
  // ═══════════════════════════════════════════════════════════════════

  private static memberStateDoc(roomId: string, uid: string) {
    return doc(db, 'p2pRooms', roomId, 'memberStates', uid);
  }

  /** 取自己的成員狀態（不存在回 null） */
  static async getMemberState(roomId: string, uid: string): Promise<RoomMemberState | null> {
    const snap = await getDoc(this.memberStateDoc(roomId, uid));
    return snap.exists() ? (snap.data() as RoomMemberState) : null;
  }

  /** 批次取多個房間中自己的狀態（dashboard 列表用；rooms ≤ 100） */
  static async getMyMemberStates(
    roomIds: string[],
    uid: string
  ): Promise<Map<string, RoomMemberState>> {
    const out = new Map<string, RoomMemberState>();
    await Promise.all(
      roomIds.map(async (roomId) => {
        try {
          const s = await this.getMemberState(roomId, uid);
          if (s) out.set(roomId, s);
        } catch {
          /* 單房失敗不擋整個列表 */
        }
      })
    );
    return out;
  }

  /** 標記已讀（進房與在房收到新訊息時呼叫） */
  static async markRead(roomId: string, uid: string): Promise<void> {
    await setDoc(this.memberStateDoc(roomId, uid), { lastReadAt: Date.now() }, { merge: true });
  }

  /** 釘選/取消釘選（列表排序：釘選一定高於未釘選，同狀態按 lastActiveAt） */
  static async setPinned(roomId: string, uid: string, pinned: boolean): Promise<void> {
    await setDoc(
      this.memberStateDoc(roomId, uid),
      { pinnedAt: pinned ? Date.now() : null },
      { merge: true }
    );
  }

  /**
   * 軟刪除聊天室（對自己隱藏）。若「所有 participants 都已軟刪除」，
   * 由本次呼叫執行真刪除（規則允許 participants 刪除房間文件）。
   * 回傳 'hidden'（僅自己隱藏）或 'deleted'（全員刪除、已真刪）。
   */
  static async softDeleteRoom(roomId: string, uid: string): Promise<'hidden' | 'deleted'> {
    await setDoc(this.memberStateDoc(roomId, uid), { deletedAt: Date.now() }, { merge: true });

    const room = await this.getRoom(roomId, true);
    if (!room) return 'deleted'; // 已被別人真刪

    const states = await Promise.all(
      room.participants.map(async (p) => ({
        uid: p,
        state: await this.getMemberState(roomId, p).catch(() => null),
      }))
    );
    const allDeleted = states.every((s) => !!s.state?.deletedAt);
    if (!allDeleted) return 'hidden';

    try {
      await this.deleteRoomSubcollections(roomId);
      await deleteDoc(doc(db, 'p2pRooms', roomId));
      logger.info('[RoomService] softDeleteRoom: all members deleted → hard delete', { roomId });
      return 'deleted';
    } catch (err) {
      // 競態（他人同時操作）下真刪失敗無妨：房間對所有人都已隱藏
      logger.warn('[RoomService] hard delete after all-soft-delete failed', { roomId, err });
      return 'hidden';
    }
  }

  /** 退出聊天室：把自己移出 participants（他人保留房間）並清掉自己的狀態。
   *  順序固定：先刪狀態再退出——退出後規則不再視你為參與者，反序會被拒寫。 */
  static async exitRoom(roomId: string, uid: string): Promise<void> {
    try {
      await deleteDoc(this.memberStateDoc(roomId, uid));
    } catch {
      /* 狀態文件不存在或刪除失敗皆無害（退出後列表查不到此房） */
    }
    await this.leaveRoom(roomId, uid);
  }

  /** 活躍度 bump：只寫 metadata（lastActiveAt + 遠期 ttl）。呼叫端請節流。 */
  static async bumpActivity(roomId: string): Promise<void> {
    const now = Date.now();
    await updateDoc(doc(db, 'p2pRooms', roomId), {
      lastActiveAt: now,
      ttlExpireAt: Timestamp.fromMillis(now + this.PERSISTENT_TTL_MS),
    });
  }

  private static async deleteRoomSubcollections(roomId: string): Promise<void> {
    const subcollections = ['signals', 'messages', 'memberStates'];
    for (const sub of subcollections) {
      try {
        const ref = collection(db, 'p2pRooms', roomId, sub);
        const snapshot = await getDocs(query(ref));
        if (snapshot.empty) continue;

        // 批次刪除（每次最多 500，Firestore 限制）
        const batch: Promise<void>[] = [];
        for (const d of snapshot.docs) {
          batch.push(deleteDoc(d.ref));
        }
        await Promise.allSettled(batch);

        if (DEBUG_ROOMS) {
          logger.info(`[RoomService] Deleted ${snapshot.size} docs from ${sub}`, { roomId });
        }
      } catch (err) {
        logger.warn(`[RoomService] Failed to cleanup subcollection ${sub}`, { roomId, err });
      }
    }
  }

  /**
   * 房主離開時的完整流程（Host Migration）：
   * 1. 將房間 status 設為 'migrating'，遞增 hostMigrationEpoch
   * 2. 嘗試從剩餘成員中選出新房主（promoteNewHost）
   * 3. 如果找到新房主：更新 ownerUid，設 status='open'
   * 4. 如果無剩餘成員：設 status='closed'（不刪除文件）
   *
   * 注意：P2P 連線由 P2PManager 管理，這裡只處理 Firestore 狀態。
   */
  static async ownerLeaveRoom(
    roomId: string,
    ownerUid: string,
    callerName?: string | null,
    promoteNewHostFn?: (
      remainingParticipants: string[],
      callerUid: string,
      callerName: string | null
    ) => Promise<string | null>
  ): Promise<{ remainingParticipants: string[]; newOwnerUid?: string }> {
    const room = await this.getRoom(roomId);
    if (!room) {
      return { remainingParticipants: [] };
    }

    if (room.ownerUid !== ownerUid) {
      throw new Error('只有房間擁有者可以執行 ownerLeaveRoom');
    }

    const remainingParticipants = room.participants.filter((p) => p !== ownerUid);

    // 使用 Transaction 確保 host migration 的所有狀態更新是原子的
    // 避免其他 peer 在 migrating → open/closed 之間讀到不一致狀態
    const result = await runTransaction(db, async (transaction) => {
      const roomDocRef = doc(db, 'p2pRooms', roomId);
      const roomSnap = await transaction.get(roomDocRef);
      if (!roomSnap.exists()) return { remainingParticipants: [] };

      const data = roomSnap.data();
      const currentEpoch = data.hostMigrationEpoch ?? 0;
      const newEpoch = currentEpoch + 1;

      if (remainingParticipants.length === 0) {
        // 無剩餘成員 → 原子地設為 closed
        transaction.update(roomDocRef, {
          status: 'closed',
          hostMigrationEpoch: newEpoch,
          participants: [],
          previousRoomId: data.previousRoomId ?? null,
          lineageRootRoomId: data.lineageRootRoomId ?? roomId,
        });

        logger.info('[RoomService] ownerLeaveRoom: no remaining, room closed (atomic)', {
          roomId, ownerUid,
        });
        return { remainingParticipants: [] as string[] };
      }

      // 有剩餘成員 → 原子地 migrating + 選新房主 + 重設為 open
      const newOwnerUid = remainingParticipants[0]!;
      transaction.update(roomDocRef, {
        status: 'open',
        ownerUid: newOwnerUid,
        hostMigrationEpoch: newEpoch,
        participants: remainingParticipants,
        previousRoomId: data.previousRoomId ?? null,
        lineageRootRoomId: data.lineageRootRoomId ?? roomId,
      });

      logger.info('[RoomService] ownerLeaveRoom: host migrated (atomic)', {
        roomId, oldOwnerUid: ownerUid, newOwnerUid, newEpoch, remainingParticipants,
      });
      return { remainingParticipants, newOwnerUid };
    });

    // 若有 promoteNewHostFn（需建立新房間），在 transaction 外執行
    // 因為 promoteNewHostFn 可能涉及多個 Firestore 操作，無法包在同一 transaction
    if (remainingParticipants.length > 0 && promoteNewHostFn) {
      const newRoomId = await promoteNewHostFn(
        remainingParticipants,
        remainingParticipants[0]!,
        callerName ?? null
      );

      if (newRoomId) {
        await updateDoc(doc(db, 'p2pRooms', roomId), {
          status: 'closed',
        });

        logger.info('[RoomService] ownerLeaveRoom: new room promoted', {
          roomId, newRoomId,
        });
      }
    }

    return result;
  }

  /**
   * Update room status
   */
  static async updateRoomStatus(roomId: string, status: RoomStatus): Promise<void> {
    await updateDoc(doc(db, 'p2pRooms', roomId), { status });
    if (DEBUG_ROOMS) {
      logger.info('[RoomService] updateRoomStatus', { roomId, status });
    }
  }

  /**
   * Increment room version (CAS bump)
   */
  static async incrementVersion(roomId: string): Promise<void> {
    // 使用 Firestore increment() 原子操作，避免 read-then-write race condition
    await updateDoc(doc(db, 'p2pRooms', roomId), {
      version: increment(1),
    });
    if (DEBUG_ROOMS) {
      logger.info('[RoomService] incrementVersion (atomic)', { roomId });
    }
  }

  /**
   * Set capability hint on the room
   */
  static async setCapabilityHint(roomId: string, capability: RoomCapability): Promise<void> {
    await updateDoc(doc(db, 'p2pRooms', roomId), {
      capabilityHint: capability,
    });
    if (DEBUG_ROOMS) {
      logger.info('[RoomService] setCapabilityHint', { roomId, capability });
    }
  }

  /**
   * 監聽使用者參與的房間
   */
  static subscribeUserRooms(
    uid: string,
    callback: (rooms: P2PRoom[]) => void
  ): () => void {
    const roomsRef = collection(db, 'p2pRooms');
    // 監聽自己參與的房間。limit 是效能上限（持久聊天室會累積）；
    // 排序在 client 做（釘選/未讀等 per-user 狀態不在房間文件上）。
    const q = query(
      roomsRef,
      where('participants', 'array-contains', uid),
      limit(100)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const rooms: P2PRoom[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        rooms.push({
          roomId: doc.id,
          roomName: data.roomName,
          ownerUid: data.ownerUid,
          ownerName: data.ownerName,
          participants: data.participants || [],
          status: data.status || 'open',
          isPrivate: !!data.isPrivate,
          createdAt: data.createdAt?.toMillis() || Date.now(),
          lastActiveAt: typeof data.lastActiveAt === 'number' ? data.lastActiveAt : data.lastActiveAt?.toMillis?.(),
          kind: data.kind,
          waitingTimeout: data.waitingTimeout || 5 * 60 * 1000,
          waitingStartedAt: data.waitingStartedAt?.toMillis(),
        });
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
    const roomDoc = doc(db, 'p2pRooms', roomId);

    const unsubscribe = onSnapshot(roomDoc, (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }

      const data = snapshot.data();
      callback({
        roomId: snapshot.id,
        ownerUid: data.ownerUid,
        ownerName: data.ownerName,
        participants: data.participants || [],
        status: data.status || 'open',
        isPrivate: !!data.isPrivate,
        createdAt: data.createdAt?.toMillis() || Date.now(),
        waitingTimeout: data.waitingTimeout || 5 * 60 * 1000,
        waitingStartedAt: data.waitingStartedAt?.toMillis(),
        meshIdentities: data.meshIdentities ? Object.fromEntries(
          (Object.entries(data.meshIdentities) as [string, FirestoreMeshIdentity][]).map(([key, value]) => [
            key,
            {
              userId: value.userId,
              pubKey: value.pubKey,
              joinedAt: (typeof value.joinedAt === 'object' && value.joinedAt?.toMillis?.()) || (typeof value.joinedAt === 'number' ? value.joinedAt : Date.now()),
            },
          ])
        ) : undefined,
        topology: data.topology || 'star',
      });
    });

    return unsubscribe;
  }

  /**
   * 監聽所有公開房間（非 private、狀態為 open）
   */
  /**
   * 公開房列表：一次性讀取（進頁載入 + 手動刷新），不再掛常駐 onSnapshot。
   *
   * 讀取衛生（2026-07-13 配額事件根因）：舊版 isPrivate 在前端過濾且無 limit，
   * Firestore 實際把「所有 open 房（含私人房與累積的測試房）」整批讀出來，
   * 每次進 dashboard 燒一次全集——8.1 萬讀/日的元兇。改為伺服器端
   * isPrivate==false + limit(20)：無論垃圾房累積多少，每次最多讀 20 筆。
   * 代價：缺 isPrivate 欄位的遠古房不再出現在公開列表（皆為測試遺留，可接受）。
   * 需要複合索引 status+isPrivate+ttlExpireAt（firestore.indexes.json）；
   * 索引未建好或查詢失敗時回空陣列並記 warn，不擋 dashboard。
   */
  static async getPublicRooms(): Promise<P2PRoom[]> {
    const roomsRef = collection(db, 'p2pRooms');
    // status == 'open' + ttlExpireAt 未過期：殭屍房（全員斷線、心跳已停）在
    // 原生 TTL 實際刪除前（可延遲 ~24h）就先從公開列表消失。
    const q = query(
      roomsRef,
      where('status', '==', 'open'),
      where('isPrivate', '==', false),
      where('ttlExpireAt', '>', Timestamp.now()),
      limit(20)
    );

    try {
      const snapshot = await getDocs(q);
      const rooms: P2PRoom[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        rooms.push({
          roomId: doc.id,
          ownerUid: data.ownerUid,
          ownerName: data.ownerName,
          participants: data.participants || [],
          status: data.status || 'open',
          isPrivate: !!data.isPrivate,
          createdAt: data.createdAt?.toMillis() || Date.now(),
          waitingTimeout: data.waitingTimeout || 5 * 60 * 1000,
          waitingStartedAt: data.waitingStartedAt?.toMillis(),
          lastActiveAt: typeof data.lastActiveAt === 'number' ? data.lastActiveAt : undefined,
        });
      });
      if (DEBUG_ROOMS) {
        logger.info('[RoomService] getPublicRooms', { count: rooms.length });
      }
      return rooms;
    } catch (err) {
      // 最可能是複合索引尚在建置（failed-precondition）；公開列表非關鍵路徑，降級為空。
      logger.warn('[RoomService] getPublicRooms failed, returning empty list', { err });
      return [];
    }
  }

  /**
   * 更新或添加小網狀架構的身分資訊
   */
  static async updateMeshIdentity(
    roomId: string,
    firebaseUid: string,
    userId: string,
    pubKey: string,
    /** ECDH 公鑰（Base64 SPKI），供 keyx 成對封裝（ADR-0023 P2-②c）。可選（舊 client 不帶）。 */
    ecdhPubKey?: string
  ): Promise<void> {
    const roomDoc = doc(db, 'p2pRooms', roomId);

    // 驗證 userId 和 pubKey 格式（純輸入檢查，不需重試）
    if (typeof userId !== 'string' || userId.length < 8 || userId.length > 64) {
      throw new Error('Invalid userId format: must be 8-64 characters');
    }
    if (typeof pubKey !== 'string' || pubKey.length < 40 || pubKey.length > 512) {
      throw new Error('Invalid pubKey format: must be 40-512 characters');
    }
    // 驗證 pubKey 是合法的 Base64
    if (!/^[A-Za-z0-9+/]+=*$/.test(pubKey)) {
      throw new Error('Invalid pubKey format: must be valid Base64');
    }
    // ecdhPubKey 同格式驗證（若提供）
    if (ecdhPubKey !== undefined) {
      if (typeof ecdhPubKey !== 'string' || ecdhPubKey.length < 40 || ecdhPubKey.length > 512) {
        throw new Error('Invalid ecdhPubKey format: must be 40-512 characters');
      }
      if (!/^[A-Za-z0-9+/]+=*$/.test(ecdhPubKey)) {
        throw new Error('Invalid ecdhPubKey format: must be valid Base64');
      }
    }

    // 寫入 meshIdentities[自己]。firestore.rules 以「更新前 doc 的 participants
    // 含自己」授權；三人幾乎同時進場時，本人的 join(arrayUnion) 可能尚未 server-commit，
    // 此刻寫入會（getDoc 讀不到自己 → 或 updateDoc 觸發 permission-denied）失敗，
    // 導致該人 mesh 初始化整場失敗、連不上。以重試等 join 傳播（毫秒級）。
    const attempt = async (): Promise<void> => {
      const snap = await getDoc(roomDoc);
      if (!snap.exists()) throw new Error('房間不存在');
      const data = snap.data();
      const participants = data.participants || [];
      if (!participants.includes(firebaseUid)) {
        throw new Error('join-not-propagated'); // 可重試：join 尚未生效
      }
      const meshIdentities = data.meshIdentities || {};
      meshIdentities[firebaseUid] = {
        userId,
        pubKey,
        ...(ecdhPubKey ? { ecdhPubKey } : {}),
        joinedAt: Date.now(),
      };
      await updateDoc(roomDoc, {
        meshIdentities,
        topology: 'mesh', // 標記為 mesh 拓撲
      });
    };

    const MAX_ATTEMPTS = 5;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        await attempt();
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = (err as Error).message;
        const retryable = msg === 'join-not-propagated' || code === 'permission-denied';
        // 「房間不存在」與格式錯誤等不可重試——立即拋出
        if (msg === '房間不存在') throw err;
        if (!retryable || i === MAX_ATTEMPTS - 1) throw err;
        await new Promise((r) => setTimeout(r, 200 * (i + 1))); // 200/400/600/800ms
      }
    }

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
  static async getMeshIdentities(
    roomId: string,
    /** true=強制 server 讀（連線建立需最新名冊）；false=允許快取（keyx 週期輪詢，省讀取） */
    forceServer = true
  ): Promise<Map<string, { userId: string; pubKey: string; ecdhPubKey?: string }>> {
    const room = await this.getRoom(roomId, forceServer);
    if (!room || !room.meshIdentities) {
      return new Map();
    }

    const identities = new Map<string, { userId: string; pubKey: string; ecdhPubKey?: string }>();
    for (const [firebaseUid, identity] of Object.entries(room.meshIdentities)) {
      identities.set(firebaseUid, {
        userId: identity.userId,
        pubKey: identity.pubKey,
        ...(identity.ecdhPubKey ? { ecdhPubKey: identity.ecdhPubKey } : {}),
      });
    }

    return identities;
  }
}
