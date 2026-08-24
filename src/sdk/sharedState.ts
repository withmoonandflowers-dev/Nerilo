/**
 * 房間共享狀態（Spec 025 T2）：per-key LWW＋晚進者快照補齊。
 *
 * 騎 Spec 023 raw 通道的可靠模式（ordered、不限重傳），label 固定 'state'（保留字，
 * 嵌入者的遊戲通道請避開）。加密、通道生命週期、丟棄語義全部繼承 raw 管線。
 * 收斂核心是 sharedStateLww 純函式；本檔只管通道與協議（q/s/d 三種訊息）。
 *
 * 誠實邊界：LWW＝高頻並發改同一 key 會互蓋（文件明示）；狀態不持久化（全員離開即消失）；
 * 晚進者拿到的是「現況」不是「歷史過程」（與 Spec 009 前向保密一致）。
 */

import { HybridLogicalClock, type HLCTimestamp } from '../core/clock/HybridLogicalClock';
import {
  applyDelta, applyBatch, exportDeltas, toView,
  type StateMap, type StateDelta,
} from '../core/state/sharedStateLww';
import { logger } from '../utils/logger';

/** 保留通道 label：transport client 會把此 label 的入站通道分流給狀態層，不進 onRawChannel。 */
export const STATE_CHANNEL_LABEL = 'state';

const MAX_VALUE_BYTES = 8 * 1024;   // 單 key 值上限（Q4）
const MAX_STATE_BYTES = 64 * 1024;  // 全狀態上限（快照須一則訊息內送完）

/** SharedState 所需的傳輸面（NeriloTransportClient 的子集，避免循環依賴）。 */
export interface StateChannelLike {
  readonly peerId: string;
  send(data: string | Uint8Array): void;
  onMessage(cb: (data: string | Uint8Array, from: string) => void): () => void;
  onClose(cb: () => void): () => void;
  dropped(): number;
}

export interface StateTransportPort {
  localId(): string | null;
  peers(): string[];
  onPeerChange(cb: (peers: string[]) => void): () => void;
  openStateChannel(peerId: string): Promise<StateChannelLike>;
  /** 狀態訂閱（Spec 024）：金鑰就緒轉換時狀態層要重發 q/s（見 resync 註解）。 */
  onStatus(cb: (s: { encryption: string }) => void): () => void;
  /** 現行送出金鑰的 epoch（null=未就緒）。代數變化＝keyx 收斂/輪替，狀態層據此 re-sync。 */
  currentEpoch(): number | null;
}

export interface SharedState {
  /** 目前收斂視圖（深拷貝；墓碑不含）。 */
  get(): Record<string, unknown>;
  /** 寫一鍵並廣播。值須可 JSON 序列化；超限（單值 8KB／全狀態 64KB）拋錯，不靜默截斷。 */
  set(key: string, value: unknown): void;
  /** 刪一鍵（墓碑增量，防舊寫入復活）。 */
  delete(key: string): void;
  /** 訂閱變化（訂閱當下先收一次目前視圖）；回傳退訂函式。 */
  onChange(cb: (state: Record<string, unknown>, changedKeys: string[]) => void): () => void;
  /** fail-visible：出站增量被丟棄的計數（金鑰未就緒／通道未開）。 */
  dropped(): number;
}

type WireMsg =
  | { t: 'q' }
  | { t: 'd'; k: string; v?: unknown; hlc: HLCTimestamp; from: string }
  | { t: 's'; entries: StateDelta[] };

export class SharedStateImpl implements SharedState {
  private map: StateMap = new Map();
  private listeners = new Set<(s: Record<string, unknown>, keys: string[]) => void>();
  private outbound = new Map<string, StateChannelLike>();
  private opening = new Set<string>();
  private clock: HybridLogicalClock | null = null;
  private unsubPeerChange: (() => void) | null = null;

  private unsubStatus: (() => void) | null = null;
  private lastEncryption = '';

  constructor(private port: StateTransportPort) {
    this.unsubPeerChange = port.onPeerChange((peers) => {
      for (const p of peers) void this.ensureOutbound(p);
    });
    // 金鑰未就緒窗口的 q/s 會被 raw 管線丟棄（Spec 023 語義：丟棄不排隊）。
    // 補償：encryption 轉為 ready 時對所有 outbound 重發 q+s（LWW 冪等，多發無害）。
    // 這是狀態層自己的責任——raw 管線不替任何人排隊，是刻意的。
    this.unsubStatus = port.onStatus((st) => {
      if (st.encryption === 'ready' && this.lastEncryption !== 'ready') this.resyncAll();
      this.lastEncryption = st.encryption;
    });
    // 同代異鑰窗（Spec 022 已知）：晚進者自選產生方時各持異鑰，早期 q/s 互解不開；
    // keyx 收斂後 epoch 會跳代。輪詢 epoch，變化即 re-sync（q+s 冪等，多發無害）。
    this.epochTimer = setInterval(() => {
      const ep = this.port.currentEpoch();
      if (ep !== null && ep !== this.lastEpoch) {
        this.lastEpoch = ep;
        this.resyncAll();
      }
    }, 2000);
    for (const p of port.peers()) void this.ensureOutbound(p);
  }

  private epochTimer: ReturnType<typeof setInterval> | null = null;
  private lastEpoch: number | null = null;

  /** 對所有 outbound 重發 q+s（金鑰就緒轉換、或未來需要的全面 re-sync）。 */
  private resyncAll(): void {
    this.outbound.forEach((ch) => {
      ch.send(JSON.stringify({ t: 'q' } satisfies WireMsg));
      ch.send(JSON.stringify({ t: 's', entries: exportDeltas(this.map) } satisfies WireMsg));
    });
  }

  /** transport client 分流入站 state 通道到這裡。 */
  acceptInbound(ch: StateChannelLike): void {
    this.wire(ch);
  }

  get(): Record<string, unknown> {
    return toView(this.map);
  }

  set(key: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`shared state value not JSON-serializable: ${key}`);
    if (encoded.length > MAX_VALUE_BYTES) {
      throw new Error(`shared state value too large (${encoded.length} > ${MAX_VALUE_BYTES}): ${key}`);
    }
    const delta = this.localDelta(key, JSON.parse(encoded) as unknown);
    const total = JSON.stringify(exportDeltas(this.map)).length;
    if (total > MAX_STATE_BYTES) {
      // 回滾這筆（fail-visible：拋錯而非靜默截斷）
      this.map.delete(key);
      throw new Error(`shared state total too large (${total} > ${MAX_STATE_BYTES})`);
    }
    this.broadcast({ t: 'd', ...delta });
    this.emit([key]);
  }

  delete(key: string): void {
    const delta = this.localDelta(key, undefined);
    this.broadcast({ t: 'd', ...delta });
    this.emit([key]);
  }

  onChange(cb: (state: Record<string, unknown>, changedKeys: string[]) => void): () => void {
    this.listeners.add(cb);
    try { cb(this.get(), Object.keys(this.get())); } catch { /* listener 錯誤不外溢 */ }
    return () => this.listeners.delete(cb);
  }

  dropped(): number {
    let n = 0;
    this.outbound.forEach((ch) => { n += ch.dropped(); });
    return n;
  }

  dispose(): void {
    if (this.epochTimer !== null) { clearInterval(this.epochTimer); this.epochTimer = null; }
    this.unsubStatus?.();
    this.unsubPeerChange?.();
    this.listeners.clear();
    this.outbound.clear();
  }

  // ── 內部 ──────────────────────────────────────────────

  private localDelta(key: string, value: unknown | undefined): StateDelta {
    const from = this.port.localId() ?? 'local';
    if (!this.clock) this.clock = new HybridLogicalClock(from.slice(0, 8));
    const delta: StateDelta = { k: key, ...(value === undefined ? {} : { v: value }), hlc: this.clock.now(), from };
    applyDelta(this.map, delta);
    return delta;
  }

  private async ensureOutbound(peerId: string): Promise<void> {
    if (this.outbound.has(peerId) || this.opening.has(peerId)) return;
    this.opening.add(peerId);
    try {
      const ch = await this.port.openStateChannel(peerId);
      this.outbound.set(peerId, ch);
      ch.onClose(() => this.outbound.delete(peerId));
      this.wire(ch);
      // 開啟即雙向互補：催對方快照（q）＋主動給我方快照（s）。LWW 冪等，多來源無害；
      // 這也讓「通道曾斷開重建」時雙方立即 re-sync，不必等下一筆增量。
      ch.send(JSON.stringify({ t: 'q' } satisfies WireMsg));
      ch.send(JSON.stringify({ t: 's', entries: exportDeltas(this.map) } satisfies WireMsg));
    } catch (error) {
      logger.warn('[SharedState] open state channel failed', { peerId, error });
    } finally {
      this.opening.delete(peerId);
    }
  }

  private wire(ch: StateChannelLike): void {
    ch.onMessage((data) => {
      let msg: WireMsg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as WireMsg;
      } catch {
        logger.warn('[SharedState] malformed state message ignored');
        return;
      }
      if (msg.t === 'q') {
        ch.send(JSON.stringify({ t: 's', entries: exportDeltas(this.map) } satisfies WireMsg));
      } else if (msg.t === 'd') {
        if (!this.clock) this.clock = new HybridLogicalClock((this.port.localId() ?? 'local').slice(0, 8));
        this.clock.receive(msg.hlc);
        if (applyDelta(this.map, msg)) this.emit([msg.k]);
      } else if (msg.t === 's') {
        if (!this.clock) this.clock = new HybridLogicalClock((this.port.localId() ?? 'local').slice(0, 8));
        for (const e of msg.entries) this.clock.receive(e.hlc);
        const changed = applyBatch(this.map, msg.entries);
        if (changed.length) this.emit(changed);
      }
    });
  }

  private broadcast(msg: WireMsg): void {
    const encoded = JSON.stringify(msg);
    this.outbound.forEach((ch) => ch.send(encoded));
    // 在場 peer 缺 outbound（首開失敗/曾斷開）→ 補開；本筆經開啟時的快照互補送達
    for (const p of this.port.peers()) {
      if (!this.outbound.has(p)) void this.ensureOutbound(p);
    }
  }

  private emit(keys: string[]): void {
    const view = this.get();
    this.listeners.forEach((cb) => {
      try { cb(view, keys); } catch (error) {
        logger.error('[SharedState] onChange listener error', { error });
      }
    });
  }
}
