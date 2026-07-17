/**
 * 房間名冊/節點發現的抽象（P2b 注入縫）。
 *
 * mesh 靠一份共享名冊互相發現：每人註冊自己的身分（userId/pubKey/ecdhPubKey，並 bump
 * joinedAt 供「離開再進」偵測），大家訂閱名冊變化來連上新節點。預設由 Firestore 的
 * p2pRooms/{roomId}.meshIdentities 實作（FirestoreRoomDirectory）；SDK 可注入自架的
 * directory（InMemoryRoomDirectory 為零 Firebase 參考實作），讓第三方帶自己的發現後端。
 */

/** 名冊中一位成員的身分。joinedAt 可能是 number 或 Firestore Timestamp（consumer 自解）。 */
export interface DirectoryIdentity {
  userId: string;
  pubKey?: string;
  ecdhPubKey?: string;
  joinedAt?: unknown;
  /**
   * 介紹人 uid（Spec 005 T4）：此成員是「經邀請連結由某人介紹」加入的。
   * 其他成員看到此欄位，對他的 signaling 會多等 warm 中繼一會兒（介紹人正把他
   * 接進 mesh），而非立刻退 Firestore——這是「第三人零 Firestore 寫入」的關鍵。
   */
  introducedBy?: string;
}

/** 房間目前狀態：名冊（key＝成員 signaling 身分 id）＋參與者名單。 */
export interface RoomSnapshot {
  meshIdentities: Record<string, DirectoryIdentity>;
  participants: string[];
}

export interface IRoomDirectory {
  /** 寫入我的身分（含 bump joinedAt）。key（我的 uid）由 adapter 於建構時持有。 */
  registerIdentity(entry: {
    userId: string;
    pubKey: string;
    ecdhPubKey?: string;
    introducedBy?: string;
  }): Promise<void>;
  /**
   * 訂閱名冊變化。onChange 於訂閱當下先收到目前狀態、之後每次變更各一次
   * （鏡像 Firestore onSnapshot 首次快照 + 後續）。回傳取消訂閱。
   */
  watchIdentities(onChange: (snapshot: RoomSnapshot) => void): () => void;
  /** 一次性讀取目前名冊。preferCached＝可接受快取（keyx 週期輪詢用；預設要最新）。 */
  getSnapshot(preferCached?: boolean): Promise<RoomSnapshot>;
}
