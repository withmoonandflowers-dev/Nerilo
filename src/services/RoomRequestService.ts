/**
 * RoomRequestService — 房間合併（Merge）與分岔（Split）請求管理
 *
 * Firestore 集合：roomRequests
 * 集合中每個文件代表一次 merge 或 split 請求/計劃。
 *
 * ── 合併流程（Merge）────────────────────────────────────────────────────────
 *
 *  Room A owner ──(createMergeRequest)──▶ Firestore roomRequests
 *       ▲                                          │
 *       │                                (subscribeIncomingMerge)
 *       │                                          ▼
 *  Room B owner ◀──────────────── 看到 pending 請求
 *       │
 *       ├─(acceptMergeRequest)─▶ 將 A 的 participants 加入 B
 *       │                        刪除 Room A（房主規則：A 消失後 A's owner 可加入 B）
 *       │                        更新 request status = 'completed'
 *       └─(rejectMergeRequest)─▶ 更新 request status = 'rejected'
 *
 * ── 分岔流程（Split）────────────────────────────────────────────────────────
 *
 *  Room A owner ──(createSplitPlan)──▶ Firestore roomRequests
 *       ▲                                          │
 *       │                               (subscribeSplitPlan)
 *       │                                          ▼
 *  newOwnerUid ◀──────────────────── 看到 pending 計劃
 *       │
 *       └─(acceptSplitPlan)─▶ newOwnerUid 建立新房間 B
 *                              participantsToSplit 從 A 移除、加入 B
 *                              更新 plan status = 'completed'
 *
 * 限制：
 *  - 每位登入使用者同時只能擁有一個房間
 *  - Merge：A 的房主在合併完成後不再擁有任何房間 → 可加入 B 為一般成員
 *  - Split：newOwnerUid 目前不能擁有任何房間
 *  - sourceOwnerUid 不能把自己分岔出去（必須留在原房間）
 */

import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  onSnapshot,
  query,
  where,
  arrayUnion,
  arrayRemove,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../config/firebase';
import { generateUUID } from '../utils/uuid';
import type { RoomMergeRequest, RoomSplitPlan } from '../types';
import { RoomService } from './RoomService';

const MERGE_EXPIRE_MS = 2 * 60 * 1000;  // 2 分鐘
const SPLIT_EXPIRE_MS  = 5 * 60 * 1000; // 5 分鐘

// ── 內部 Firestore 文件轉換 ─────────────────────────────────────────────────

/** Firestore Timestamp 類型的最小介面 */
interface FirestoreTimestampLike {
  toMillis(): number;
}

/** 將可能為 Firestore Timestamp 或 number 的值轉換為 number */
function toMillis(value: unknown): number {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as FirestoreTimestampLike).toMillis();
  }
  return typeof value === 'number' ? value : Date.now();
}

function docToMergeRequest(id: string, data: Record<string, unknown>): RoomMergeRequest {
  return {
    requestId: id,
    type: 'merge',
    status: data.status as RoomMergeRequest['status'],
    sourceRoomId: data.sourceRoomId as string,
    sourceOwnerUid: data.sourceOwnerUid as string,
    targetRoomId: data.targetRoomId as string,
    targetOwnerUid: data.targetOwnerUid as string,
    createdAt: toMillis(data.createdAt),
    expiresAt: toMillis(data.expiresAt),
  };
}

function docToSplitPlan(id: string, data: Record<string, unknown>): RoomSplitPlan {
  return {
    planId: id,
    type: 'split',
    status: data.status as RoomSplitPlan['status'],
    sourceRoomId: data.sourceRoomId as string,
    sourceOwnerUid: data.sourceOwnerUid as string,
    newRoomOwnerUid: data.newRoomOwnerUid as string,
    participantsToSplit: (data.participantsToSplit as string[]) ?? [],
    newRoomId: data.newRoomId as string | undefined,
    createdAt: toMillis(data.createdAt),
    expiresAt: toMillis(data.expiresAt),
  };
}

// ── RoomRequestService ───────────────────────────────────────────────────────

export class RoomRequestService {

  // ══════════════════════════════════════════════════════════════
  // MERGE — 合併請求
  // ══════════════════════════════════════════════════════════════

  /**
   * 發起合併請求：Room A 的房主希望把 Room A 合併進 Room B
   *
   * @param sourceRoomId   Room A（發起者自己的房間，合併後將被刪除）
   * @param sourceOwnerUid Room A 的房主 UID
   * @param targetRoomId   Room B（存活的目標房間）
   * @param targetOwnerUid Room B 的房主 UID（用來顯示通知）
   * @returns requestId
   */
  static async createMergeRequest(
    sourceRoomId: string,
    sourceOwnerUid: string,
    targetRoomId: string,
    targetOwnerUid: string
  ): Promise<string> {
    // 確認 source 房間存在且呼叫者是房主
    const sourceRoom = await RoomService.getRoom(sourceRoomId);
    if (!sourceRoom) throw new Error('來源房間不存在');
    if (sourceRoom.ownerUid !== sourceOwnerUid) throw new Error('只有房主可以發起合併請求');

    // 確認 target 房間存在且狀態為 open
    const targetRoom = await RoomService.getRoom(targetRoomId);
    if (!targetRoom) throw new Error('目標房間不存在');
    if (targetRoom.status !== 'open') throw new Error('目標房間目前不開放合併');
    if (targetRoom.ownerUid !== targetOwnerUid) throw new Error('目標房主資訊不符');

    const requestId = generateUUID();
    const now = Date.now();

    await setDoc(doc(db, 'roomRequests', requestId), {
      type: 'merge',
      status: 'pending',
      sourceRoomId,
      sourceOwnerUid,
      targetRoomId,
      targetOwnerUid,
      createdAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + MERGE_EXPIRE_MS),
    });

    // 在目標房間寫入 pendingMergeRequestId，讓 B 的房主可以快速訂閱
    await updateDoc(doc(db, 'p2pRooms', targetRoomId), {
      pendingMergeRequestId: requestId,
    });

    console.log('[RoomRequestService] Merge request created', {
      requestId,
      sourceRoomId,
      targetRoomId,
    });

    return requestId;
  }

  /**
   * 目標房主接受合併請求
   *
   * Firestore 執行順序：
   * 1. 將 Room A 的 participants 加入 Room B
   * 2. 刪除 Room A 文件（房間從列表消失）
   * 3. 清除 Room B 上的 pendingMergeRequestId
   * 4. 更新 request status = 'completed'
   *
   * Chain 後續動作（由呼叫端使用 onChainAction callback 執行）：
   * - Room B owner 呼叫 ChainMergeService.writeMergeMarker()
   *   把合併事件寫入 Room B 的主鏈
   * - Room A 成員透過 P2P 宣告 provenance（chain-sync:provenance-announce）
   *   Room B 成員收到後請求並儲存 Room A 的鏈
   *
   * @param onChainAction 可選的 chain 操作回呼，在 Firestore 更新完成後呼叫。
   *   接收 mergeInfo，呼叫端可用來：
   *   - 呼叫 ChainMergeService.writeMergeMarker(sourceRoomId, sourceOwnerUid)
   */
  static async acceptMergeRequest(
    requestId: string,
    targetOwnerUid: string,
    onChainAction?: (mergeInfo: {
      sourceRoomId: string;
      sourceOwnerUid: string;
      targetRoomId: string;
      mergedParticipants: string[];
    }) => Promise<void>
  ): Promise<void> {
    const requestDoc = await getDoc(doc(db, 'roomRequests', requestId));
    if (!requestDoc.exists()) throw new Error('合併請求不存在');

    const request = docToMergeRequest(requestDoc.id, requestDoc.data());
    if (request.status !== 'pending') throw new Error('請求已處理過');
    if (request.targetOwnerUid !== targetOwnerUid) throw new Error('只有目標房主可以接受合併');
    if (Date.now() > request.expiresAt) throw new Error('合併請求已過期');

    // 取得雙方房間資料
    const [sourceRoom, targetRoom] = await Promise.all([
      RoomService.getRoom(request.sourceRoomId),
      RoomService.getRoom(request.targetRoomId),
    ]);

    if (!targetRoom) throw new Error('目標房間已不存在');
    const sourceParticipants = sourceRoom?.participants ?? [];

    // 1. 將 source 的所有成員加入 target
    if (sourceParticipants.length > 0) {
      await updateDoc(doc(db, 'p2pRooms', request.targetRoomId), {
        participants: arrayUnion(...sourceParticipants),
      });
    }

    // 2. 刪除 source 房間（讓 A 的房主符合「一次只擁有一個房間」的規則，
    //    因為 A 消失了，A 的房主就不再是任何房間的擁有者，可以加入 B）
    if (sourceRoom) {
      await RoomService.deleteRoom(request.sourceRoomId, request.sourceOwnerUid);
    }

    // 3. 清除 target 上的 pendingMergeRequestId
    await updateDoc(doc(db, 'p2pRooms', request.targetRoomId), {
      pendingMergeRequestId: null,
    });

    // 4. 更新 request 狀態
    await updateDoc(doc(db, 'roomRequests', requestId), {
      status: 'completed',
    });

    console.log('[RoomRequestService] Merge accepted (Firestore done)', {
      requestId,
      sourceRoomId: request.sourceRoomId,
      targetRoomId: request.targetRoomId,
      mergedParticipants: sourceParticipants,
    });

    // 5. Chain 操作（在 Firestore 更新完成後執行，由呼叫端提供）
    //    典型用法：
    //    await mergeService.writeMergeMarker(sourceRoomId, sourceOwnerUid)
    if (onChainAction) {
      await onChainAction({
        sourceRoomId: request.sourceRoomId,
        sourceOwnerUid: request.sourceOwnerUid,
        targetRoomId: request.targetRoomId,
        mergedParticipants: sourceParticipants,
      });
    }
  }

  /**
   * 目標房主拒絕合併請求
   */
  static async rejectMergeRequest(
    requestId: string,
    targetOwnerUid: string
  ): Promise<void> {
    const requestDoc = await getDoc(doc(db, 'roomRequests', requestId));
    if (!requestDoc.exists()) throw new Error('合併請求不存在');

    const request = docToMergeRequest(requestDoc.id, requestDoc.data());
    if (request.targetOwnerUid !== targetOwnerUid) throw new Error('只有目標房主可以拒絕合併');

    await Promise.all([
      updateDoc(doc(db, 'roomRequests', requestId), { status: 'rejected' }),
      // 清除 target 上的 pendingMergeRequestId
      updateDoc(doc(db, 'p2pRooms', request.targetRoomId), {
        pendingMergeRequestId: null,
      }),
    ]);

    console.log('[RoomRequestService] Merge rejected', { requestId });
  }

  /**
   * 訂閱「送進來」的合併請求（目標房主用）
   *
   * @param targetOwnerUid 目標房主 UID（監聽所有以此為 targetOwnerUid 的 pending 請求）
   * @param callback 回呼，帶入所有 pending 請求列表
   * @returns 取消訂閱函式
   */
  static subscribeIncomingMergeRequests(
    targetOwnerUid: string,
    callback: (requests: RoomMergeRequest[]) => void
  ): () => void {
    const q = query(
      collection(db, 'roomRequests'),
      where('type', '==', 'merge'),
      where('targetOwnerUid', '==', targetOwnerUid),
      where('status', '==', 'pending')
    );

    return onSnapshot(q, (snapshot) => {
      const requests = snapshot.docs
        .map((d) => docToMergeRequest(d.id, d.data()))
        .filter((r) => Date.now() <= r.expiresAt); // 前端也過濾過期項目
      callback(requests);
    });
  }

  /**
   * 訂閱「送出去」的合併請求狀態（發起房主用）
   */
  static subscribeMergeRequestStatus(
    requestId: string,
    callback: (request: RoomMergeRequest | null) => void
  ): () => void {
    return onSnapshot(doc(db, 'roomRequests', requestId), (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      callback(docToMergeRequest(snapshot.id, snapshot.data()));
    });
  }

  // ══════════════════════════════════════════════════════════════
  // SPLIT — 分岔計劃
  // ══════════════════════════════════════════════════════════════

  /**
   * 房主發起分岔計劃：把部分成員分出去形成新房間
   *
   * 限制：
   * - newRoomOwnerUid 必須是 source 的現有成員
   * - newRoomOwnerUid 目前不能擁有任何房間（否則違反「一人一房」規則）
   * - sourceOwnerUid 不能出現在 participantsToSplit 中（房主必須留在原房間）
   * - participantsToSplit 至少包含 newRoomOwnerUid
   *
   * @returns planId
   */
  static async createSplitPlan(
    sourceRoomId: string,
    sourceOwnerUid: string,
    newRoomOwnerUid: string,
    participantsToSplit: string[]
  ): Promise<string> {
    if (newRoomOwnerUid === sourceOwnerUid) {
      throw new Error('房主不能把自己分岔出去，必須留在原房間');
    }
    if (!participantsToSplit.includes(newRoomOwnerUid)) {
      throw new Error('participantsToSplit 必須包含 newRoomOwnerUid');
    }
    if (participantsToSplit.includes(sourceOwnerUid)) {
      throw new Error('原房主不能加入 participantsToSplit（必須留在原房間）');
    }

    // 確認 source 房間
    const sourceRoom = await RoomService.getRoom(sourceRoomId);
    if (!sourceRoom) throw new Error('來源房間不存在');
    if (sourceRoom.ownerUid !== sourceOwnerUid) throw new Error('只有房主可以發起分岔');

    // 確認 participantsToSplit 都在 source 房間
    const invalidMembers = participantsToSplit.filter(
      (uid) => !sourceRoom.participants.includes(uid)
    );
    if (invalidMembers.length > 0) {
      throw new Error(`以下成員不在房間內：${invalidMembers.join(', ')}`);
    }

    // 確認 newRoomOwnerUid 目前沒有自己的房間
    const existingRoomsSnap = await getDocs(
      query(collection(db, 'p2pRooms'), where('ownerUid', '==', newRoomOwnerUid))
    );
    // 只考慮 waiting/open 狀態的房間（closed 的不影響）
    const activeOwnedRooms = existingRoomsSnap.docs.filter(
      (d) => d.data().status !== 'closed'
    );
    if (activeOwnedRooms.length > 0) {
      throw new Error('指定的新房主目前已擁有一個房間，無法再建立新房間');
    }

    const planId = generateUUID();
    const now = Date.now();

    await setDoc(doc(db, 'roomRequests', planId), {
      type: 'split',
      status: 'pending',
      sourceRoomId,
      sourceOwnerUid,
      newRoomOwnerUid,
      participantsToSplit,
      createdAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + SPLIT_EXPIRE_MS),
    });

    // 在 source 房間寫入 pendingSplitPlanId，讓 newRoomOwnerUid 可快速感知
    await updateDoc(doc(db, 'p2pRooms', sourceRoomId), {
      pendingSplitPlanId: planId,
    });

    console.log('[RoomRequestService] Split plan created', {
      planId,
      sourceRoomId,
      newRoomOwnerUid,
      participantsToSplit,
    });

    return planId;
  }

  /**
   * 被指定的新房主接受分岔計劃
   *
   * Firestore 執行順序：
   * 1. newRoomOwnerUid 建立新房間（自動帶入 participantsToSplit）
   * 2. 將 participantsToSplit 從 source 房間移除
   * 3. 清除 source 上的 pendingSplitPlanId
   * 4. 更新 plan status = 'completed'，填入 newRoomId
   *
   * Chain 後續動作（由呼叫端使用 onChainAction callback 執行）：
   * - new Room B owner 呼叫 ChainMergeService.writeSplitFromMarker(sourceRoomId, sourceEntries)
   *   其中 sourceEntries = 從 IndexedDB 讀取的 Room A 鏈（new owner 本人在 A 所以有）
   * - Room A owner 偵測到 split completed 後呼叫
   *   ChainMergeService.writeSplitToMarker(targetRoomId, participantsToSplit)
   *
   * @param planId          分岔計劃 ID
   * @param newRoomOwnerUid 接受者（必須與計劃中的 newRoomOwnerUid 一致）
   * @param ownerName       新房主的顯示名稱
   * @param onChainAction   可選的 chain 操作回呼，在 Firestore 更新完成後呼叫
   * @returns 新建立的房間 ID
   */
  static async acceptSplitPlan(
    planId: string,
    newRoomOwnerUid: string,
    ownerName: string | null,
    onChainAction?: (splitInfo: {
      newRoomId: string;
      sourceRoomId: string;
      sourceOwnerUid: string;
      participantsToSplit: string[];
    }) => Promise<void>
  ): Promise<string> {
    const planDoc = await getDoc(doc(db, 'roomRequests', planId));
    if (!planDoc.exists()) throw new Error('分岔計劃不存在');

    const plan = docToSplitPlan(planDoc.id, planDoc.data());
    if (plan.status !== 'pending') throw new Error('分岔計劃已處理過');
    if (plan.newRoomOwnerUid !== newRoomOwnerUid) throw new Error('只有指定的新房主可以接受分岔');
    if (Date.now() > plan.expiresAt) throw new Error('分岔計劃已過期');

    // 1. 建立新房間（RoomService.createRoom 會自動關閉 newRoomOwnerUid 的舊房間，
    //    但我們已在 createSplitPlan 驗證過他沒有舊房間，所以這步是安全的）
    const newRoomId = await RoomService.createRoom(
      newRoomOwnerUid,
      ownerName,
      false, // 預設公開
      plan.participantsToSplit
    );

    // 2. 從 source 房間移除 participantsToSplit
    await updateDoc(doc(db, 'p2pRooms', plan.sourceRoomId), {
      participants: arrayRemove(...plan.participantsToSplit),
      pendingSplitPlanId: null,
    });

    // 3. 更新 plan 狀態
    await updateDoc(doc(db, 'roomRequests', planId), {
      status: 'completed',
      newRoomId,
    });

    console.log('[RoomRequestService] Split plan accepted (Firestore done)', {
      planId,
      sourceRoomId: plan.sourceRoomId,
      newRoomId,
      movedParticipants: plan.participantsToSplit,
    });

    // 4. Chain 操作（Firestore 完成後，由呼叫端執行）
    //    典型用法：
    //    const sourceEntries = await indexedDBService.getChainEntries(sourceRoomId)
    //    await mergeService.writeSplitFromMarker(sourceRoomId, sourceEntries)
    if (onChainAction) {
      await onChainAction({
        newRoomId,
        sourceRoomId: plan.sourceRoomId,
        sourceOwnerUid: plan.sourceOwnerUid,
        participantsToSplit: plan.participantsToSplit,
      });
    }

    return newRoomId;
  }

  /**
   * 取消分岔計劃（由 source 房主或 newRoomOwnerUid 發起）
   */
  static async cancelSplitPlan(
    planId: string,
    callerUid: string
  ): Promise<void> {
    const planDoc = await getDoc(doc(db, 'roomRequests', planId));
    if (!planDoc.exists()) throw new Error('分岔計劃不存在');

    const plan = docToSplitPlan(planDoc.id, planDoc.data());
    if (plan.sourceOwnerUid !== callerUid && plan.newRoomOwnerUid !== callerUid) {
      throw new Error('只有原房主或指定新房主可以取消分岔');
    }

    await Promise.all([
      updateDoc(doc(db, 'roomRequests', planId), { status: 'cancelled' }),
      updateDoc(doc(db, 'p2pRooms', plan.sourceRoomId), { pendingSplitPlanId: null }),
    ]);

    console.log('[RoomRequestService] Split plan cancelled', { planId });
  }

  /**
   * 訂閱「送給我的」分岔計劃（newRoomOwnerUid 用）
   */
  static subscribeIncomingSplitPlan(
    newRoomOwnerUid: string,
    callback: (plans: RoomSplitPlan[]) => void
  ): () => void {
    const q = query(
      collection(db, 'roomRequests'),
      where('type', '==', 'split'),
      where('newRoomOwnerUid', '==', newRoomOwnerUid),
      where('status', '==', 'pending')
    );

    return onSnapshot(q, (snapshot) => {
      const plans = snapshot.docs
        .map((d) => docToSplitPlan(d.id, d.data()))
        .filter((p) => Date.now() <= p.expiresAt);
      callback(plans);
    });
  }

  /**
   * 訂閱單一分岔計劃的狀態變化（source 房主用，確認是否 completed）
   */
  static subscribeSplitPlanStatus(
    planId: string,
    callback: (plan: RoomSplitPlan | null) => void
  ): () => void {
    return onSnapshot(doc(db, 'roomRequests', planId), (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      callback(docToSplitPlan(snapshot.id, snapshot.data()));
    });
  }

  // ══════════════════════════════════════════════════════════════
  // PROMOTE NEW HOST — 房主離開後自動選出新代理房主
  // ══════════════════════════════════════════════════════════════

  /**
   * 當房主離開且房間從 Firebase 刪除後，若有剩餘成員，
   * 從中選出「目前沒有自己房間」的第一位成員，由他建立新房間，
   * 讓剩餘成員可以繼續從 Firebase 被發現（新人加入的入口）。
   *
   * 呼叫時機：ownerLeaveRoom() 之後，由前端協調呼叫。
   *
   * 規則：
   * - 只有當 callerUid === promotedOwnerUid（由 UID 排序取最小值）時才執行建立，
   *   避免多個剩餘成員同時建立多個房間。
   * - 若所有剩餘成員都已擁有房間，則不建立新房間（P2P 連線仍可持續，但無法新人加入）。
   *
   * @param remainingParticipants 離開後的剩餘成員 UID 列表
   * @param callerUid             目前呼叫此函式的使用者（用來判斷誰負責建立）
   * @param callerName            建立者的顯示名稱
   * @returns 新房間 ID，若不需要建立則回傳 null
   */
  static async promoteNewHost(
    remainingParticipants: string[],
    callerUid: string,
    callerName: string | null
  ): Promise<string | null> {
    if (remainingParticipants.length === 0) return null;

    // 找出沒有房間的成員（UID 排序後取最小，決定誰負責建立）
    const noRoomCandidates: string[] = [];
    for (const uid of remainingParticipants) {
      const snap = await getDocs(
        query(collection(db, 'p2pRooms'), where('ownerUid', '==', uid))
      );
      const hasActiveRoom = snap.docs.some((d) => d.data().status !== 'closed');
      if (!hasActiveRoom) {
        noRoomCandidates.push(uid);
      }
    }

    if (noRoomCandidates.length === 0) {
      console.log('[RoomRequestService] promoteNewHost: all remaining members own rooms, skipping');
      return null;
    }

    // 排序後取最小 UID 作為新房主（確定性選取，避免多人同時建立）
    const promotedOwnerUid = [...noRoomCandidates].sort()[0]!;

    if (promotedOwnerUid !== callerUid) {
      // 不是我負責建立，等待他人建立
      console.log('[RoomRequestService] promoteNewHost: not my turn to create', {
        promotedOwnerUid,
        callerUid,
      });
      return null;
    }

    // 我負責建立新房間，加入所有剩餘成員
    const newRoomId = await RoomService.createRoom(
      callerUid,
      callerName,
      false,
      remainingParticipants
    );

    console.log('[RoomRequestService] promoteNewHost: new room created', {
      newRoomId,
      promotedOwnerUid,
      participants: remainingParticipants,
    });

    return newRoomId;
  }
}
