/**
 * App Lifecycle Manager
 *
 * 處理行動裝置與瀏覽器的背景/前景切換，確保 P2P 連線能正確恢復：
 *
 * 1. **visibilitychange** — 偵測 App 進入背景/恢復前景
 * 2. **freeze/resume** — Page Lifecycle API（Chrome 68+）
 * 3. **online/offline** — 網路狀態變化
 * 4. **beforeunload** — 頁面關閉前清理
 *
 * 當 App 進入背景時：
 * - 記錄離線時間戳
 * - （iOS Safari 會在 ~30s 後凍結 WebRTC）
 *
 * 當 App 恢復前景時：
 * - 計算離線時長
 * - 觸發連線檢查 → 重連 if needed
 * - Drain store-and-forward inbox
 * - 通知 UI 層更新
 */

import { logger } from '../../utils/logger';

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type AppState = 'active' | 'passive' | 'hidden' | 'frozen' | 'terminated';

export interface LifecycleEvent {
  previousState: AppState;
  currentState: AppState;
  timestamp: number;
  offlineDurationMs?: number; // 只在 hidden → active 時有值
}

export type LifecycleListener = (event: LifecycleEvent) => void;

export interface AppLifecycleConfig {
  /** 離線超過此時間（毫秒）視為需要重連，預設 60s */
  reconnectThresholdMs?: number;
  /** 是否自動在 beforeunload 觸發 cleanup callback，預設 true */
  handleBeforeUnload?: boolean;
}

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_RECONNECT_THRESHOLD_MS = 60_000; // 1 minute

// ── Manager ──────────────────────────────────────────────────────────────────

export class AppLifecycleManager {
  private state: AppState = 'active';
  private hiddenAt: number | null = null;
  private reconnectThresholdMs: number;
  private listeners: Map<string, Set<LifecycleListener>> = new Map();
  private boundHandlers: {
    visibility?: () => void;
    freeze?: () => void;
    resume?: () => void;
    online?: () => void;
    offline?: () => void;
    beforeunload?: () => void;
  } = {};

  constructor(config: AppLifecycleConfig = {}) {
    this.reconnectThresholdMs =
      config.reconnectThresholdMs ?? DEFAULT_RECONNECT_THRESHOLD_MS;
  }

  /**
   * 開始監聽瀏覽器生命週期事件
   * 傳入 document 和 window 以便測試時可以 mock
   */
  start(
    doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> = document,
    win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'navigator'> = window
  ): void {
    // visibilitychange（所有瀏覽器支援）
    this.boundHandlers.visibility = () => {
      if (doc.visibilityState === 'hidden') {
        this.transition('hidden');
      } else if (doc.visibilityState === 'visible') {
        this.transition('active');
      }
    };
    doc.addEventListener('visibilitychange', this.boundHandlers.visibility);

    // freeze / resume（Page Lifecycle API，Chrome 68+）
    this.boundHandlers.freeze = () => this.transition('frozen');
    this.boundHandlers.resume = () => this.transition('active');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Page Lifecycle API 尚未納入 lib.dom.d.ts
    doc.addEventListener('freeze' as any, this.boundHandlers.freeze);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.addEventListener('resume' as any, this.boundHandlers.resume);

    // online / offline
    this.boundHandlers.online = () => {
      this.emit('network', {
        previousState: this.state,
        currentState: this.state,
        timestamp: Date.now(),
      });
      // 網路恢復 → 觸發重連檢查
      if (this.state !== 'active') {
        this.transition('active');
      } else {
        // 即使已是 active，也通知需要重連檢查
        this.emit('reconnect-needed', {
          previousState: 'active',
          currentState: 'active',
          timestamp: Date.now(),
          offlineDurationMs: 0,
        });
      }
    };
    this.boundHandlers.offline = () => {
      this.emit('network', {
        previousState: this.state,
        currentState: this.state,
        timestamp: Date.now(),
      });
    };
    win.addEventListener('online', this.boundHandlers.online);
    win.addEventListener('offline', this.boundHandlers.offline);

    // beforeunload
    this.boundHandlers.beforeunload = () => {
      this.transition('terminated');
    };
    win.addEventListener('beforeunload', this.boundHandlers.beforeunload);

    // 設定初始狀態
    this.state = doc.visibilityState === 'hidden' ? 'hidden' : 'active';
  }

  /**
   * 狀態轉換
   */
  private transition(newState: AppState): void {
    const prev = this.state;
    if (prev === newState) return;

    const now = Date.now();
    let offlineDurationMs: number | undefined;

    // 記錄進入背景的時間
    if (newState === 'hidden' || newState === 'frozen') {
      this.hiddenAt = now;
    }

    // 從背景恢復 → 計算離線時長
    if (
      (prev === 'hidden' || prev === 'frozen') &&
      (newState === 'active' || newState === 'passive')
    ) {
      if (this.hiddenAt) {
        offlineDurationMs = now - this.hiddenAt;
        this.hiddenAt = null;
      }
    }

    this.state = newState;

    const event: LifecycleEvent = {
      previousState: prev,
      currentState: newState,
      timestamp: now,
      offlineDurationMs,
    };

    // 通知所有 state-change 監聽器
    this.emit('state-change', event);

    // 如果從背景恢復且離線時間超過閾值，觸發重連
    if (
      offlineDurationMs !== undefined &&
      offlineDurationMs >= this.reconnectThresholdMs
    ) {
      this.emit('reconnect-needed', event);
    }

    // 如果回到前景，都觸發 drain（無論離線多久都檢查 inbox）
    if (newState === 'active' && prev !== 'active') {
      this.emit('drain-inbox', event);
    }

    logger.info('[AppLifecycleManager] State transition', {
      from: prev,
      to: newState,
      offlineDurationMs,
    });
  }

  // ── 事件系統 ───────────────────────────────────────────────────────

  /**
   * 監聽特定事件
   * @param event  'state-change' | 'reconnect-needed' | 'drain-inbox' | 'network'
   */
  on(event: string, listener: LifecycleListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  private emit(event: string, data: LifecycleEvent): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(data);
      } catch (err) {
        logger.error(`[AppLifecycleManager] Error in ${event} listener`, err);
      }
    }
  }

  // ── 查詢 ──────────────────────────────────────────────────────────

  /** 目前 App 狀態 */
  getState(): AppState {
    return this.state;
  }

  /** 是否處於背景 */
  isBackground(): boolean {
    return this.state === 'hidden' || this.state === 'frozen';
  }

  /** 是否在線 */
  isOnline(): boolean {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  }

  // ── 清理 ──────────────────────────────────────────────────────────

  stop(
    doc: Pick<Document, 'removeEventListener'> = document,
    win: Pick<Window, 'removeEventListener'> = window
  ): void {
    if (this.boundHandlers.visibility) {
      doc.removeEventListener('visibilitychange', this.boundHandlers.visibility);
    }
    if (this.boundHandlers.freeze) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc.removeEventListener('freeze' as any, this.boundHandlers.freeze);
    }
    if (this.boundHandlers.resume) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc.removeEventListener('resume' as any, this.boundHandlers.resume);
    }
    if (this.boundHandlers.online) {
      win.removeEventListener('online', this.boundHandlers.online);
    }
    if (this.boundHandlers.offline) {
      win.removeEventListener('offline', this.boundHandlers.offline);
    }
    if (this.boundHandlers.beforeunload) {
      win.removeEventListener('beforeunload', this.boundHandlers.beforeunload);
    }

    this.boundHandlers = {};
    this.listeners.clear();
  }
}
