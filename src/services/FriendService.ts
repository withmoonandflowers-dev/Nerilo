/**
 * 好友系統（2026-07-05 產品決策）
 *
 * - 好友碼 = Firebase uid（MVP；不做 email 搜尋——避免使用者目錄洩漏）。
 * - friendships/{id}：id 為排序後的 `${uidA}_${uidB}`（確定性、天然防重複），
 *   {uids, names, requestedBy, status: pending|accepted, dmRoomId?}。
 * - 接受邀請時自動建立 kind:'dm' 的雙人聊天室（沿用持久聊天室模型：
 *   已讀/釘選/軟刪除全部適用）。
 */
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../config/firebase';
import { RoomService } from './RoomService';
import { logger } from '../utils/logger';

export interface Friendship {
  id: string;
  uids: [string, string];
  /** 雙方顯示名稱（邀請時寫自己的，接受時補上另一方） */
  names: Record<string, string>;
  requestedBy: string;
  status: 'pending' | 'accepted';
  createdAt: number;
  acceptedAt?: number;
  dmRoomId?: string;
}

function pairId(a: string, b: string): string {
  return [a, b].sort().join('_');
}

export class FriendService {
  /** 送出好友邀請（friendCode = 對方 uid） */
  static async sendRequest(
    myUid: string,
    myName: string,
    friendCode: string
  ): Promise<void> {
    const target = friendCode.trim();
    if (!target) throw new Error('請輸入好友碼');
    if (target === myUid) throw new Error('這是你自己的好友碼');

    const id = pairId(myUid, target);
    const ref = doc(db, 'friendships', id);
    // 讀既有關係防重複。注意：規則的 read 條件是 `uid in resource.data.uids`，
    // 對「不存在的文件」resource 為 null → 評估錯誤 → permission-denied。
    // 因此讀失敗（多半就是不存在）一律當作「無既有關係」繼續，不阻斷邀請。
    try {
      const existing = await getDoc(ref);
      if (existing.exists()) {
        const data = existing.data() as Friendship;
        throw new Error(data.status === 'accepted' ? '你們已經是好友了' : '邀請已存在（等待接受）');
      }
    } catch (e) {
      if (e instanceof Error && (e.message.includes('好友') || e.message.includes('邀請'))) throw e;
      /* permission-denied / 不存在 → 視為無既有關係 */
    }

    await setDoc(ref, {
      uids: [myUid, target].sort(),
      names: { [myUid]: myName },
      requestedBy: myUid,
      status: 'pending',
      createdAt: Timestamp.now(),
    });
    logger.info('[FriendService] request sent', { id });
  }

  /** 接受邀請：建立 DM 聊天室 + 標記 accepted。回傳 dmRoomId。 */
  static async accept(friendship: Friendship, myUid: string, myName: string): Promise<string> {
    if (friendship.status !== 'pending') throw new Error('邀請狀態已變更');
    if (friendship.requestedBy === myUid) throw new Error('等待對方接受你的邀請');

    const other = friendship.uids.find((u) => u !== myUid)!;
    const otherName = friendship.names[other] ?? '朋友';

    // DM 房：接受方建房後直接補上雙方成員並轉 open（持久、kind:'dm'）
    const dmRoomId = await RoomService.createRoom(
      myUid,
      myName,
      false, // 連結即邀請模型；不公開列出（公開列表已移除）
      [],
      undefined,
      true,
      `${otherName} ✦ ${myName}`
    );
    await updateDoc(doc(db, 'p2pRooms', dmRoomId), {
      participants: [myUid, other].sort(),
      participantCount: 2,
      status: 'open',
      kind: 'dm',
      lastActiveAt: Date.now(),
      ttlExpireAt: Timestamp.fromMillis(Date.now() + RoomService.PERSISTENT_TTL_MS),
    });

    await updateDoc(doc(db, 'friendships', friendship.id), {
      status: 'accepted',
      acceptedAt: Timestamp.now(),
      dmRoomId,
      [`names.${myUid}`]: myName,
    });
    logger.info('[FriendService] accepted', { id: friendship.id, dmRoomId });
    return dmRoomId;
  }

  /** 拒絕邀請 / 解除好友（friendship 文件移除；DM 房由聊天室刪除流程處理） */
  static async remove(friendshipId: string): Promise<void> {
    await deleteDoc(doc(db, 'friendships', friendshipId));
  }

  /** 訂閱我的好友關係（含 pending 雙向） */
  static subscribeFriendships(
    uid: string,
    callback: (list: Friendship[]) => void
  ): () => void {
    const q = query(collection(db, 'friendships'), where('uids', 'array-contains', uid));
    return onSnapshot(q, (snapshot) => {
      const list: Friendship[] = [];
      snapshot.forEach((d) => {
        const data = d.data();
        list.push({
          id: d.id,
          uids: data.uids,
          names: data.names ?? {},
          requestedBy: data.requestedBy,
          status: data.status,
          createdAt: data.createdAt?.toMillis?.() ?? 0,
          acceptedAt: data.acceptedAt?.toMillis?.(),
          dmRoomId: data.dmRoomId,
        });
      });
      callback(list);
    }, (err) => {
      logger.warn('[FriendService] subscribe error', { code: (err as { code?: string }).code });
    });
  }
}
