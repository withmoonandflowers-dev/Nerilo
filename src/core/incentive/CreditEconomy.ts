/**
 * CreditEconomy — 點數經濟（正向循環的骨架，ADR-0020）
 *
 * 把三件事接成一條循環：
 *   在線/連線（玩遊戲時天然發生）→ 累積點數 → 遊戲可查/可花
 *
 * 願景：玩家為了玩遊戲而在線，在線即貢獻網路容量（未來接 P2 relay 時
 * 中繼他人流量），因此「玩遊戲的人不知不覺參與基礎建設」並賺得點數。
 *
 * 定位（Phase 1）：
 * - 建在既有 LocalCreditProvider 之上（複用其節流/負債下限/tier）。
 * - 本機單一節點餘額，localStorage 持久化（跨 session 累積；無 localStorage
 *   環境退化為記憶體）。刻意不用 Dexie（避免 schema 遷移）。
 * - 框架無關（純 src/core）：React 與未來 Vue 都消費同一顆 singleton。
 *
 * 誠實邊界：
 * - 本機點數尚無 sybil 抵抗——兌換真實權益前必須補防刷（見 threat-model F-payment）。
 * - 累積綁「實際連線中」而非「開著分頁」，降低純掛機刷點（呼叫端負責只在
 *   connected 時 startEarning）。
 */

import { LocalCreditProvider } from './LocalCreditProvider';
import { DEFAULT_CREDIT_RATES } from './types';
import type { CreditBalance, ServiceTier } from '../relay/types';
import type { CreditLedger, VerifyResult, EarnAttestation } from './CreditLedger';
import { generateUUID } from '../../utils/uuid';
import { logger } from '../../utils/logger';

const STORAGE_KEY = 'nerilo.credits.v1';
/** 在線累積 tick：每 60 秒結算一次（pro-rata 於 perUptimeHour） */
const ACCRUAL_TICK_MS = 60_000;

export type CreditListener = (balance: CreditBalance) => void;

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

export class CreditEconomy {
  private provider = new LocalCreditProvider();
  private nodeId: string | null = null;
  private listeners = new Set<CreditListener>();

  // 在線累積狀態
  private accrualTimer: ReturnType<typeof setInterval> | null = null;
  private earning = false;

  /** 可選的可驗證帳本（ADR-0022）：attach 後每筆賺/花以簽章串鏈記錄，可驗防竄改 */
  private ledger: CreditLedger | null = null;

  /**
   * 掛上可驗證帳本。之後每筆 earn/spend 以「實際套用的差額」附加成簽章 entry。
   * 記錄的是 provider 真正套用的量（例：節流後可能為 0 就不記），故帳本與餘額一致。
   */
  attachLedger(ledger: CreditLedger): void {
    this.ledger = ledger;
  }

  /** 驗證帳本完整性（防竄改）。未掛帳本回 ok=true（無可驗即無竄改風險）。 */
  async verifyLedger(): Promise<VerifyResult> {
    return this.ledger ? this.ledger.verify() : { ok: true };
  }

  /** 匯出帳本（稽核/傳輸）。未掛帳本回 null。 */
  exportLedger(): string | null {
    return this.ledger ? this.ledger.serialize() : null;
  }

  /**
   * 把「實際差額」記進帳本（差額 <= 0 或未掛帳本則略過）。
   * earn 必附 attestation（Spec 002 / R5）：收據或白名單自證，由帳本 fail-closed 把關。
   */
  private recordToLedger(op: 'spend', amount: number, reason: string): void;
  private recordToLedger(op: 'earn', amount: number, reason: string, attestation: EarnAttestation): void;
  private recordToLedger(op: 'earn' | 'spend', amount: number, reason: string, attestation?: EarnAttestation): void {
    if (!this.ledger || amount <= 0) return;
    const p = op === 'earn'
      ? this.ledger.append('earn', amount, reason, Date.now(), generateUUID(), attestation!)
      : this.ledger.append('spend', amount, reason, Date.now(), generateUUID());
    void p.catch((err) => {
      logger.warn('[CreditEconomy] ledger append failed', { err });
    });
  }

  /** 讀本機餘額數字（同步，內部用；provider 已同步回傳） */
  private currentBalance(): number {
    if (!this.nodeId) return 0;
    for (const b of this.provider.exportBalances()) {
      if (b.nodeId === this.nodeId) return b.balance;
    }
    return 0;
  }

  /** 綁定本機節點並載入持久化餘額。重複 init 同一 nodeId 為 no-op。 */
  init(nodeId: string): void {
    if (this.nodeId === nodeId) return;
    this.nodeId = nodeId;
    const saved = this.load();
    if (saved && saved.nodeId === nodeId) {
      this.provider.importBalances([saved]);
    }
    // 確保餘額存在（新節點拿初始 grant）
    void this.provider.getBalance(nodeId);
  }

  /**
   * 開始在線累積：呼叫端應「只在實際 connected 時」呼叫（玩遊戲=在線=賺點）。
   * 每 tick pro-rata 結算 perUptimeHour；stop 時結算殘餘時間。
   */
  startEarning(): void {
    if (this.earning || !this.nodeId) return;
    this.earning = true;
    let lastTick = Date.now();

    this.accrualTimer = setInterval(() => {
      const now = Date.now();
      const hours = (now - lastTick) / 3_600_000;
      lastTick = now;
      this.accrue(hours);
    }, ACCRUAL_TICK_MS);
  }

  /** 停止累積（離開房間/斷線）。tick 制下不補殘餘（下次進房再賺），保持簡單可測。 */
  stopEarning(): void {
    if (this.accrualTimer) {
      clearInterval(this.accrualTimer);
      this.accrualTimer = null;
    }
    this.earning = false;
  }

  private accrue(hours: number): void {
    if (!this.nodeId || hours <= 0) return;
    const before = this.currentBalance();
    this.provider.recordUptime(this.nodeId, hours);
    // 在線累積無交易對手 → 白名單自證（明白標注，稽核可辨識）
    this.recordToLedger('earn', this.currentBalance() - before, 'uptime', { kind: 'self', basis: 'uptime' });
    this.persistAndEmit();
  }

  /**
   * 中繼貢獻 → 產生點數（ADR-0021「中繼即價值」的核心）。
   * 本機為他人轉發了 bytesRelayed bytes 時呼叫；依 perKbRelayed + perRelayBonus
   * 獎勵本機節點，走 LocalCreditProvider 既有的每小時上限節流（防刷）。
   *
   * requesterNodeId 供稽核（誰的流量）。attestation 必填（Spec 002 / R5）：
   * 正常路徑帶共簽收據（信使驗過、帳本再驗一次 fail-closed，縱深防禦）。
   * Nerilo 只「產生」點數，怎麼兌換由上層/玩家決定（不在本專案範圍）。
   */
  async recordRelayContribution(
    requesterNodeId: string,
    bytesRelayed: number,
    attestation: EarnAttestation
  ): Promise<void> {
    if (!this.nodeId || bytesRelayed <= 0) return;
    const before = this.currentBalance();
    await this.provider.recordRelay(this.nodeId, requesterNodeId, bytesRelayed, 'local');
    this.recordToLedger('earn', this.currentBalance() - before, 'relay', attestation);
    this.persistAndEmit();
  }

  // ── 遊戲面向 facade ────────────────────────────────────────────────────────

  async getBalance(): Promise<CreditBalance | null> {
    if (!this.nodeId) return null;
    return this.provider.getBalance(this.nodeId);
  }

  async getServiceTier(): Promise<ServiceTier> {
    if (!this.nodeId) return 'free';
    return this.provider.getServiceTier(this.nodeId);
  }

  /**
   * 遊戲花點數。回傳是否成功（餘額不足即 false，不會扣）。
   * reason 供稽核/UI 呈現（例如 'game:powerup'）。
   */
  async trySpend(amount: number, reason: string): Promise<boolean> {
    if (!this.nodeId || amount <= 0) return false;
    const ok = await this.provider.deductCredits(this.nodeId, amount);
    if (ok) {
      this.recordToLedger('spend', amount, reason);
      logger.info('[CreditEconomy] spent', { amount, reason });
      this.persistAndEmit();
    }
    return ok;
  }

  /** 訂閱餘額變化（UI 反應式呈現）。回傳取消訂閱函式。 */
  subscribe(listener: CreditListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── 持久化 ─────────────────────────────────────────────────────────────────

  private persistAndEmit(): void {
    if (!this.nodeId) return;
    const balances = this.provider.exportBalances();
    const mine = balances.find((b) => b.nodeId === this.nodeId);
    if (!mine) return;
    this.save(mine);
    for (const fn of this.listeners) {
      try {
        fn({ ...mine });
      } catch (err) {
        logger.warn('[CreditEconomy] listener threw', { err });
      }
    }
  }

  private save(balance: CreditBalance): void {
    if (!hasLocalStorage()) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(balance));
    } catch {
      /* 容量滿：記憶體模式繼續 */
    }
  }

  private load(): CreditBalance | null {
    if (!hasLocalStorage()) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as CreditBalance) : null;
    } catch {
      return null;
    }
  }

  /** 測試/登出用 */
  reset(): void {
    this.stopEarning();
    this.provider.clear();
    this.nodeId = null;
    this.listeners.clear();
    if (hasLocalStorage()) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* noop */
      }
    }
  }
}

/** 全域單例：連線生命週期 startEarning/stopEarning、遊戲 trySpend、UI subscribe */
export const creditEconomy = new CreditEconomy();

export { DEFAULT_CREDIT_RATES };
