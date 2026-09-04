/**
 * 房間加入流程，從 RoomService 拆出。
 *
 * 本模組集中處理可讀公開房的絕對值 transaction、不可讀私有房的受限盲寫、
 * 舊房相容、重複加入冪等、狀態錯誤與名冊競態重試。呼叫端只需提供 Firestore
 * 實例與持久房 TTL，不應另行複製這套判斷。
 */
import {
  arrayUnion,
  doc,
  getDocFromServer,
  increment,
  runTransaction,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import type { P2PRoom } from '../types';
import { logger } from '../utils/logger';
import { roomCapacity } from './roomCapacity';

/** 名冊寫入共用重試；rules 競態也可能把前置條件衝突回報為 permission-denied。 */
export async function withRosterRetry(
  label: string,
  ctx: Record<string, unknown>,
  run: () => Promise<void>
): Promise<void> {
  const MAX_ATTEMPTS = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await run();
      return;
    } catch (err: unknown) {
      const code: string = (err as { code?: string })?.code ?? '';
      const isRetryable =
        code === 'failed-precondition' || code === 'aborted' || code === 'permission-denied';
      if (!isRetryable || attempt >= MAX_ATTEMPTS) throw err;
      const delayMs = 150 * attempt;
      logger.warn(`[RoomService] ${label} transaction conflict, retrying`, {
        ...ctx, attempt, code, delayMs,
      });
      await new Promise(r => setTimeout(r, delayMs));
      lastError = err;
    }
  }
  throw lastError;
}

export async function joinRoomWithRetry(
  db: Parameters<typeof runTransaction>[0],
  roomId: string,
  uid: string,
  persistentTtlMs: number
): Promise<void> {
  logger.info('[RoomService] joinRoom called', { roomId, uid });
  const state = { addedByThisCall: false };
  await withRosterRetry('joinRoom', { roomId, uid }, () =>
    joinRoomOnce(db, roomId, uid, persistentTtlMs, state)
  );
}

async function joinRoomOnce(
  db: Parameters<typeof runTransaction>[0],
  roomId: string,
  uid: string,
  persistentTtlMs: number,
  state: { addedByThisCall: boolean }
): Promise<void> {
  const roomDocRef = doc(db, 'p2pRooms', roomId);
  const now = Date.now();
  const ttlExpireAt = Timestamp.fromMillis(now + persistentTtlMs);
  type JoinCode = 'room-not-found' | 'room-closed' | 'room-migrating' | 'room-full';
  const joinError = (code: JoinCode, status?: P2PRoom['status'], capacity?: number) => Object.assign(new Error(
    code === 'room-not-found' ? '房間不存在' :
      code === 'room-closed' ? '房間已關閉，請返回房間列表' :
        code === 'room-migrating' ? '房間正在遷移主機中，請稍後重試' :
          `房間已滿（上限 ${capacity} 人）`
  ), { code, ...(status ? { roomStatus: status } : {}) });

  const assertReadableRoomCanJoin = (roomData: Partial<P2PRoom>): string[] => {
    if (roomData.status === 'closed') throw joinError('room-closed', roomData.status);
    if (roomData.status === 'migrating') throw joinError('room-migrating', roomData.status);
    const participants = roomData.participants || [];
    if (!participants.includes(uid)) {
      const capacity = roomCapacity(roomData);
      if (participants.length >= capacity) throw joinError('room-full', roomData.status, capacity);
    }
    return participants;
  };

  const completeBlindJoin = async (): Promise<void> => {
    let rejectionError: Error | null = null;
    await runTransaction(db, async (transaction) => {
      const roomSnap = await transaction.get(roomDocRef);
      if (!roomSnap.exists()) throw joinError('room-not-found');
      const roomData = roomSnap.data() as Partial<P2PRoom>;
      const participants = roomData.participants || [];
      if (!participants.includes(uid))
        throw Object.assign(new Error('加入房間後名冊未包含本人'), { code: 'failed-precondition' });

      if (roomData.status === 'closed' || roomData.status === 'migrating') {
        const roomStatus = roomData.status as 'closed' | 'migrating';
        rejectionError = joinError(`room-${roomStatus}`, roomStatus);
        // migrating 在 rules 沒有事前閘門；盲寫成功後須先以 isSelfLeaveOnly 退出。
        // closed 可能在盲寫與本 transaction 之間發生，同樣不能留下新成員。
        const remainingParticipants = participants.filter((participant) => participant !== uid);
        transaction.update(roomDocRef, { participants: remainingParticipants,
          participantCount: remainingParticipants.length, lastActiveAt: now, ttlExpireAt });
        return;
      }

      const shouldActivate = roomData.status === 'waiting' && participants.length >= 2;
      if (shouldActivate)
        transaction.update(roomDocRef, { status: 'open', lastActiveAt: now, ttlExpireAt });
      logger.info('[RoomService] joinRoom - blind join completed', { roomId, uid,
        newStatus: shouldActivate ? 'open' : roomData.status, newParticipantCount: participants.length });
    });
    state.addedByThisCall = false;
    if (rejectionError) throw rejectionError;
  };

  let readableSnap: Awaited<ReturnType<typeof getDocFromServer>>;
  try {
    readableSnap = await getDocFromServer(roomDocRef);
  } catch (readError: unknown) {
    const code = (readError as { code?: string })?.code ?? '';
    if (code !== 'permission-denied' && !code.endsWith('/permission-denied')) throw readError;

    // 四種相容情境：公開新房與公開舊房都可讀，走下方絕對值 transaction；
    // 私有新房讀不到，才以 arrayUnion + increment 盲寫；私有舊房缺 participantCount，
    // 盲寫會被 participantCountMatches 拒絕，仍須資料回填。
    try {
      await updateDoc(roomDocRef, { participants: arrayUnion(uid), participantCount: increment(1),
        lastActiveAt: now, ttlExpireAt });
      state.addedByThisCall = true;
    } catch (writeError: unknown) {
      const writeCode = (writeError as { code?: string })?.code ?? '';
      if (writeCode === 'not-found' || writeCode.endsWith('/not-found'))
        throw joinError('room-not-found');
      logger.warn('[RoomService] blind join denied; legacy private room may need participantCount backfill',
        { roomId, uid, code: writeCode });
      throw writeError;
    }
    await completeBlindJoin();
    return;
  }

  if (!readableSnap.exists()) throw joinError('room-not-found');
  const readableData = readableSnap.data() as Partial<P2PRoom>;
  if (state.addedByThisCall) {
    await completeBlindJoin();
    return;
  }
  const readableParticipants = assertReadableRoomCanJoin(readableData);

  if (readableParticipants.includes(uid)) {
    if (readableData.participantCount !== readableParticipants.length) {
      if (readableData.ownerUid === uid) {
        // 現行 rules 只有 isOwnerManagedUpdate 允許修 participantCount；用 transaction
        // 重讀名冊，避免在修正期間有人加入而寫回過期的絕對值。
        let repaired = false;
        await runTransaction(db, async (transaction) => {
          const latestSnap = await transaction.get(roomDocRef);
          if (!latestSnap.exists()) throw joinError('room-not-found');
          const latestData = latestSnap.data() as Partial<P2PRoom>;
          const latestParticipants = latestData.participants || [];
          if (latestData.ownerUid === uid
            && latestParticipants.includes(uid)
            && latestData.participantCount !== latestParticipants.length) {
            transaction.update(roomDocRef, { participantCount: latestParticipants.length });
            repaired = true;
          }
        });
        if (repaired)
          logger.warn('[RoomService] joinRoom - owner repaired participantCount mismatch', { roomId, uid });
      } else {
        // isParticipantActivityUpdate 不允許一般成員改 participantCount，不硬寫也不放寬 rules。
        logger.warn('[RoomService] joinRoom - participantCount mismatch requires owner repair', {
          roomId, uid, participantCount: readableData.participantCount,
          participantsLength: readableParticipants.length,
        });
      }
    }
    logger.info('[RoomService] joinRoom - already a participant, no-op', { roomId, uid });
    return;
  }

  // 可讀代表公開房。新舊文件都以 transaction 的最新名冊計算絕對值，天然冪等。
  await runTransaction(db, async (transaction) => {
    const roomSnap = await transaction.get(roomDocRef);
    if (!roomSnap.exists()) throw joinError('room-not-found');
    const roomData = roomSnap.data() as Partial<P2PRoom>;
    const participants = assertReadableRoomCanJoin(roomData);
    if (participants.includes(uid)) {
      logger.info('[RoomService] joinRoom - concurrent join already completed, no-op', { roomId, uid });
      return;
    }
    const nextParticipants = [...participants, uid];
    const shouldActivate = roomData.status === 'waiting' && nextParticipants.length >= 2;
    transaction.update(roomDocRef, { participants: nextParticipants,
      participantCount: nextParticipants.length,
      ...(shouldActivate ? { status: 'open' } : {}), lastActiveAt: now, ttlExpireAt });
    logger.info('[RoomService] joinRoom - readable transaction committed', { roomId, uid,
      newStatus: shouldActivate ? 'open' : roomData.status, newParticipantCount: nextParticipants.length });
  });
}
