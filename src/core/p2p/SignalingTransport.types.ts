/**
 * SignalingTransport 契約（純介面，零實作依賴）。
 *
 * 與具體實作分家（ADR-0025 / 架構收斂 2026-07）：`RoomSignalingTransport`（Firestore）等
 * 實作在 `SignalingTransport.ts`。SDK 公開表面只依賴本檔的介面，型別圖不會被 Firebase 污染。
 * 契約定義見 P2PConnectionManager 的 signaling 抽象。
 */

/** 收到的原始 signal 文件（manager 再做 dedup/過濾/handle）。 */
export interface RawSignalDoc {
  signalId: string;
  from?: string;
  to?: string | null;
  type?: string;
  payload?: unknown;
  channelLabel?: string;
}

export interface SignalingTransport {
  /**
   * 訂閱新增的 signal。cutoffMs = 只看此毫秒之後寫入的（lookback 下限）。
   * onAdded 對每筆「新增」文件呼叫一次（含自己送的——由 manager 過濾）。回傳取消訂閱。
   */
  subscribe(cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void;
  /** 寫一則 signal（manager 已組好 doc，含 from/to/type/payload/createdAt/channelLabel）。 */
  send(data: Record<string, unknown>): Promise<void>;
  /** 清理早於 beforeMs 的舊 signal（best-effort；relay 版可 no-op）。 */
  cleanupOlderThan(beforeMs: number): Promise<void>;
  /** 離開時清掉自己（localUid）這條 channel 送出的 signals（best-effort；relay 版可 no-op）。 */
  cleanupOwn(localUid: string): Promise<void>;
}

/**
 * 依 (roomId, channelLabel) 造一個 SignalingTransport。mesh 每條鄰居連線各造一個
 * （channelLabel 不同）。這是 SDK 的後端注入縫：預設走 Firestore，第三方可換自架。
 */
export type SignalingFactory = (roomId: string, channelLabel: string) => SignalingTransport;
