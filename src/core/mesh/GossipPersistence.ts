import type { GossipMessage } from '../../types';

/**
 * 複本持久化 port（ADR-0023 P1）
 *
 * 讓 GossipMessageHandler 的三樣狀態跨頁面生命週期存活：
 * - 自己的 seq 計數（reserve-then-send：先保留再送，重載/重進永不重用 seq
 *   → 根治「新訊息與對方 store 舊 seq 碰撞被當重複丟棄」）
 * - 訊息紀錄複本（(senderId, seq) → 已簽名紀錄；重載後仍能補齊他人）
 * - floors（淘汰語義：floor 前不回補）
 *
 * 實作在 services 層（Dexie）；core 只依賴此介面，單元測試注入假實作。
 * null（未注入或初始化失敗）= 記憶體模式，行為與 P1 之前完全相同。
 */
export interface IGossipPersistence {
  /**
   * 原子保留下一個 seq（讀取+遞增+寫回在單一交易內）。
   * 回傳保留到的 seq。crash 於 reserve 與送出之間只會留下 seq 空洞——
   * anti-entropy 對此容忍（空洞永遠掛在 digest missing，僅損耗一個名額）。
   */
  reserveSeq(roomId: string, senderId: string): Promise<number>;

  /** 載入整房複本：紀錄 + floors + 自己的 seq 水位（無資料時皆為空/0） */
  loadRoom(roomId: string): Promise<{
    records: GossipMessage[];
    floors: Array<{ senderId: string; floor: number }>;
  }>;

  /** 寫入一筆紀錄（idempotent；(roomId, senderId, seq) 為主鍵） */
  saveRecord(roomId: string, message: GossipMessage): Promise<void>;

  /** 淘汰一筆紀錄並推進 floor */
  evictRecord(roomId: string, senderId: string, seq: number, newFloor: number): Promise<void>;
}
