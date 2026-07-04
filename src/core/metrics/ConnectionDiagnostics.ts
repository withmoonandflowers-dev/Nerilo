/**
 * ConnectionDiagnostics — P2P 連線事件軌跡（監控除錯）
 *
 * 為什麼需要它：Sentry 抓 JS 例外，但抓不到這架構最難的 bug——
 * 「WebRTC 連線靜默失敗」。ICE 沒穿透、DataChannel 卡在哪個 state、
 * HELLO 協商斷在哪，都不是 exception。本模組記錄連線生命週期事件到環形緩衝，
 * 除錯時 dump、也能當 Sentry breadcrumb 附在錯誤上（在 config 層 forward，
 * core 不直接相依 Sentry，維持分層）。
 *
 * 設計：純環形緩衝 + 訂閱，無外部相依、無持久化（連線期即時診斷）。
 */

export interface ConnEvent {
  /** 事件時間戳（ms） */
  t: number;
  /** 事件種類，如 'state:connected' / 'ice-restart' / 'hello-negotiated' */
  kind: string;
  /** 選填細節（roomId、狀態等，勿放敏感內容） */
  detail?: Record<string, unknown>;
}

export type ConnEventListener = (event: ConnEvent) => void;

/** 環形緩衝上限：夠回溯一次連線的完整生命週期，又不吃記憶體 */
const DEFAULT_CAPACITY = 120;

export class ConnectionDiagnostics {
  private buffer: ConnEvent[] = [];
  private listeners = new Set<ConnEventListener>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** 記一筆事件。detail 僅放診斷用 metadata，勿放使用者內容。 */
  record(kind: string, detail?: Record<string, unknown>): void {
    const event: ConnEvent = { t: Date.now(), kind, ...(detail ? { detail } : {}) };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift(); // 環形：丟最舊
    }
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* forwarder 自己的錯不影響診斷本身 */
      }
    }
  }

  /** 取最近 n 筆（預設全部），供除錯 dump */
  getRecent(n?: number): ConnEvent[] {
    if (n === undefined || n >= this.buffer.length) return [...this.buffer];
    return this.buffer.slice(this.buffer.length - n);
  }

  /** 訂閱事件（Sentry breadcrumb forwarder 用）。回傳取消訂閱。 */
  subscribe(listener: ConnEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.buffer = [];
  }
}

/** 全域單例：連線層 record、config 層 subscribe forward 到 Sentry */
export const connectionDiagnostics = new ConnectionDiagnostics();
