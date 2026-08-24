/**
 * 房間目錄契約（Spec 014）：列出可加入的房間、公告我開的房、收掉。
 *
 * 跟 `IRoomDirectory` 是兩件事，名字像但別搞混（這正是本契約誕生的原因）：
 *  - `IRoomDirectory`＝**單一房間內**的成員名冊（誰在這間房、mesh 身分）。
 *  - `IRoomCatalog`＝**有哪些房間可以加入**（大廳視角，跨房間）。
 *
 * 意圖層級的最小集合（list／watch／publish／unpublish），刻意不含房間生命週期的
 * 其餘部分（join／activate／成員管理），那些留在應用層。
 */

/** 目錄中的一間房。`meta` 是應用層自由欄位（遊戲的 mode、聊天的別的，不進契約）。 */
export interface CatalogRoom {
  id: string;
  name?: string;
  /** 目前人數（後端提供才有）。 */
  occupancy?: number;
  /** 容量上限（後端提供才有）。 */
  capacity?: number;
  meta?: Record<string, unknown>;
}

export interface IRoomCatalog {
  /** 一次性列出可加入的房間。 */
  list(): Promise<CatalogRoom[]>;
  /**
   * 訂閱目錄變化。語義對齊 `IRoomDirectory.watchIdentities`：
   * 訂閱當下先收一次目前狀態，之後每次變更各一次。回傳退訂函式。
   */
  watch(onChange: (rooms: CatalogRoom[]) => void): () => void;
  /**
   * 公告一間房。回傳**權威 id**（實作期修訂：後端可能自行生成 id——Firestore 版
   * 即如此——caller 提供的 `room.id` 只是建議值，以回傳值為準）。
   */
  publish(room: Omit<CatalogRoom, 'id'> & { id?: string }): Promise<string>;
  /** 收掉自己公告的房。冪等：不存在不拋錯。 */
  unpublish(id: string): Promise<void>;
}
