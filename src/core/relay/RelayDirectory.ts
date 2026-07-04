/**
 * RelayDirectory — 中繼節點發現層（全域 relay overlay 的「誰可中繼」，ADR-0021）
 *
 * overlay 的第一塊：節點宣告「我願意中繼」，其他節點查詢候選。這是 RelayManager
 * 那顆路由大腦缺的「網路名冊」——沒有它 buildPathsTo 沒有候選節點可選。
 *
 * 分層：介面 IRelayDirectory + 記憶體實作（可測、可跑模擬）。Production 的
 * Firestore adapter（跨房發現）另建——它需要 Firestore rules（目前平行 session
 * 維護中），故本回合只交付邏輯，adapter 留部署接縫。
 *
 * 安全/隱私考量（記錄於此，adapter 實作時落實）：
 * - 宣告只含 nodeId + 粗略 metrics + regionHint，不含 IP（隱私）。
 * - TTL 過期：斷線節點自動從名冊消失（心跳式），避免路由到死節點。
 * - 反女巫：Firestore adapter 需綁真實 auth（非匿名）+ 速率限制，防灌假中繼節點。
 */

import type { RelayNodeMetrics } from './types';

/** 一則中繼可用性宣告 */
export interface RelayAnnouncement {
  nodeId: string;
  /** 宣告時間戳（TTL 判斷用） */
  announcedAt: number;
  /** 相對願意程度/容量（選路參考，選填） */
  capacity?: number;
  /** 地區提示（路徑多樣性；不精確定位） */
  regionHint?: string;
  /** 粗略節點指標（餵 RelayScorer；不含 IP） */
  metrics?: Partial<RelayNodeMetrics>;
}

export interface RelayQueryOptions {
  /** 排除此 nodeId（通常是自己） */
  excludeNodeId?: string;
  /** 最多回傳幾筆 */
  limit?: number;
}

export interface IRelayDirectory {
  /** 宣告本節點可中繼（重複宣告 = 更新/續期） */
  announce(announcement: RelayAnnouncement): Promise<void>;
  /** 撤回宣告（離線/停止中繼） */
  withdraw(nodeId: string): Promise<void>;
  /** 查詢目前可用的中繼候選（已濾除過期） */
  query(options?: RelayQueryOptions): Promise<RelayAnnouncement[]>;
}

/** 記憶體實作：可測、可跑多節點模擬。多個 RelayManager 共用同一實例即模擬全域名冊。 */
export class InMemoryRelayDirectory implements IRelayDirectory {
  private entries = new Map<string, RelayAnnouncement>();

  /**
   * @param ttlMs 宣告存活時間；超過視為過期（節點沒續期即消失）。預設 30 秒。
   * @param now 時間來源（測試可注入固定時鐘）
   */
  constructor(
    private readonly ttlMs: number = 30_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  async announce(announcement: RelayAnnouncement): Promise<void> {
    this.entries.set(announcement.nodeId, { ...announcement });
  }

  async withdraw(nodeId: string): Promise<void> {
    this.entries.delete(nodeId);
  }

  async query(options: RelayQueryOptions = {}): Promise<RelayAnnouncement[]> {
    const cutoff = this.now() - this.ttlMs;
    const fresh: RelayAnnouncement[] = [];
    for (const entry of this.entries.values()) {
      if (entry.announcedAt < cutoff) continue; // 過期
      if (options.excludeNodeId && entry.nodeId === options.excludeNodeId) continue;
      fresh.push({ ...entry });
    }
    // capacity 高者優先（選填），其次較新者
    fresh.sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0) || b.announcedAt - a.announcedAt);
    return options.limit !== undefined ? fresh.slice(0, options.limit) : fresh;
  }

  /** 測試/維運用：目前名冊大小（含過期，未清理） */
  size(): number {
    return this.entries.size;
  }
}
