/**
 * RelayOverlay — 把「發現層」接到「路由大腦」（ADR-0021）
 *
 * 職責：
 * 1. announceSelf()：向 RelayDirectory 宣告本節點可中繼（含粗略 metrics）。
 * 2. refresh()：查目錄 → 把新候選 registerPeer 進 RelayManager、把消失的
 *    unregisterPeer。這就是「填 buildPathsTo 的候選節點」——overlay 的核心。
 * 3. 週期執行 refresh + 續期 announce（心跳式，斷線者 TTL 自動消失）。
 *
 * 這是 RelayManager 路由能實際運作的前提：沒有候選節點，sendViaRelay 無路可選。
 */

import type { RelayManager } from './RelayManager';
import type { IRelayDirectory, RelayAnnouncement } from './RelayDirectory';
import type { RelayNodeMetrics } from './types';
import { logger } from '../../utils/logger';

export interface RelayOverlayOptions {
  /** 每輪最多納入幾個候選（避免無上限連線） */
  maxCandidates?: number;
  /** refresh + 續期間隔（ms），預設 15 秒（需 < 目錄 TTL） */
  refreshIntervalMs?: number;
}

export class RelayOverlay {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 目前已納入 RelayManager 的候選 nodeId，供差異比對 */
  private registered = new Set<string>();
  private selfMetrics: Partial<RelayNodeMetrics> = {};
  private selfCapacity = 1;

  constructor(
    private readonly relay: RelayManager,
    private readonly directory: IRelayDirectory,
    private readonly localNodeId: string,
    private readonly options: RelayOverlayOptions = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  /** 宣告本節點可中繼（含粗略 metrics/capacity）。 */
  async announceSelf(metrics: Partial<RelayNodeMetrics> = {}, capacity = 1): Promise<void> {
    this.selfMetrics = metrics;
    this.selfCapacity = capacity;
    await this.directory.announce({
      nodeId: this.localNodeId,
      announcedAt: this.now(),
      capacity,
      regionHint: metrics.regionHint,
      metrics,
    });
  }

  /**
   * 查目錄 → 同步 RelayManager 的候選節點（新增 register、消失 unregister）。
   * 回傳本輪納入的候選數（供監控/測試）。
   */
  async refresh(): Promise<number> {
    const limit = this.options.maxCandidates ?? 8;
    let candidates: RelayAnnouncement[];
    try {
      candidates = await this.directory.query({ excludeNodeId: this.localNodeId, limit });
    } catch (err) {
      logger.warn('[RelayOverlay] directory query failed', { err });
      return this.registered.size;
    }

    const seen = new Set<string>();
    for (const c of candidates) {
      seen.add(c.nodeId);
      if (!this.registered.has(c.nodeId)) {
        this.relay.registerPeer(c.nodeId, c.metrics ?? {});
        this.registered.add(c.nodeId);
      }
    }
    // 目錄中已消失（TTL 過期/撤回）的候選 → 移除
    for (const nodeId of [...this.registered]) {
      if (!seen.has(nodeId)) {
        this.relay.unregisterPeer(nodeId);
        this.registered.delete(nodeId);
      }
    }
    return this.registered.size;
  }

  /** 啟動週期 refresh + 續期 announce。 */
  start(): void {
    if (this.timer) return;
    const interval = this.options.refreshIntervalMs ?? 15_000;
    const tick = () => {
      void this.announceSelf(this.selfMetrics, this.selfCapacity);
      void this.refresh();
    };
    this.timer = setInterval(tick, interval);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.directory.withdraw(this.localNodeId);
  }

  /** 目前已納入的候選 nodeId（測試/監控用） */
  getRegisteredCandidates(): string[] {
    return [...this.registered];
  }
}
