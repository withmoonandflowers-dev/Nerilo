import type { GossipMessage } from '../../types';

/**
 * 複本持久化 port（ADR-0023 P1；Spec 009 起分代）
 *
 * 讓 GossipMessageHandler 的狀態跨頁面生命週期存活：
 * - 自己的 seq 計數（reserve-then-send：先保留再送，重載/重進永不重用 seq
 *   → 根治「新訊息與對方 store 舊 seq 碰撞被當重複丟棄」）
 * - 自己的 sessionEpoch（Spec 009：每會話配發一次，單調遞增且以 Date.now() 為下限
 *   → 清儲存/換裝置後的新代仍高於舊代，不會被他人已採納的現行代拒收）
 * - 訊息紀錄複本（(senderId, sessionEpoch, seq) → 已簽名紀錄；重載後仍能補齊他人）
 * - floors（淘汰語義：現行代的 floor 前不回補）
 * - acceptedEpochs（收端已驗證的 per-sender 現行代；重載後立即拒舊代重放）
 *
 * 實作在 services 層（Dexie）；core 只依賴此介面，單元測試注入假實作。
 * null（未注入或初始化失敗）= 記憶體模式。
 */
export interface IGossipPersistence {
  /**
   * 原子保留下一個 seq（讀取+遞增+寫回在單一交易內）。
   * 回傳保留到的 seq。crash 於 reserve 與送出之間只會留下 seq 空洞——
   * anti-entropy 對此容忍（空洞永遠掛在 digest missing，僅損耗一個名額）。
   */
  reserveSeq(roomId: string, senderId: string): Promise<number>;

  /**
   * 保留本會話代（Spec 009 §4.4）：回傳 max(持久化的下一值, Date.now())，
   * 並持久化下一值＝配發值+1。每個進房會話呼叫一次。
   * Date.now() 下限：即使持久化遺失（清儲存），下一次配發仍高於先前任何代
   * （舊代由更早的時鐘種出）；時鐘倒退屬文件揭露的 fail-closed 殘留。
   */
  reserveSessionEpoch(roomId: string, senderId: string): Promise<number>;

  /** 載入整房複本：紀錄 + 分代 floors + 已驗證現行代（無資料時皆為空） */
  loadRoom(roomId: string): Promise<{
    records: GossipMessage[];
    floors: Array<{ senderId: string; epoch: number; floor: number }>;
    acceptedEpochs: Array<{ senderId: string; epoch: number }>;
  }>;

  /** 寫入一筆紀錄（idempotent；(roomId, senderId, sessionEpoch, seq) 為主鍵） */
  saveRecord(roomId: string, message: GossipMessage): Promise<void>;

  /** 淘汰一筆紀錄並推進該代 floor */
  evictRecord(
    roomId: string,
    senderId: string,
    sessionEpoch: number,
    seq: number,
    newFloor: number
  ): Promise<void>;

  /** 持久化某 sender 已驗證的現行代（採納即寫，best-effort 由呼叫端吞錯） */
  saveAcceptedEpoch(roomId: string, senderId: string, epoch: number): Promise<void>;

  /** 列出目前持有紀錄的所有 roomId（盲信使備份：備份「我有資料的房」，含已離開仍持有者）。 */
  listRooms(): Promise<string[]>;
}
