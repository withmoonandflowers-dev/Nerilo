/**
 * StateFrameCodec — 60Hz 狀態幀（走 unreliable 'state' 通道，ADR-0019）
 *
 * 幀格式（binary，複用 ADR-0018 原語）：
 *   [seq: varint][rosterVer: varint][payload: component bytes]
 *
 * 設計約定：
 * - seq 單調遞增；通道 unordered+lossy，收端用 FrameGate 丟棄 stale 幀
 *   （落後的幀直接丟，不補傳——下一幀天然覆蓋）。
 * - rosterVer：名冊版本。名冊（誰在場、實體歸屬）走 **reliable control 通道**，
 *   每幀帶上發送當下的名冊版本；收端名冊版本落後於幀時，緩到名冊追上再套用，
 *   解決「亂序通道 + 名冊變更」的一致性（不然幀可能引用還不認識的實體）。
 * - 狀態幀**禁用 Firestore fallback**（P2P-only）：幀未經應用層 E2EE
 *  （2 人直連時 DTLS 已加密線路），經伺服器中繼即違反「fallback 一律密文」鐵律。
 */

import { Writer, readerFrom, type ComponentDescriptor, type ComponentSchema, type InferData } from './schema';

export interface StateFrame<T> {
  seq: number;
  rosterVer: number;
  data: T;
}

export interface StateFrameDescriptor<S extends ComponentSchema> {
  encode(seq: number, rosterVer: number, data: InferData<S>): Uint8Array;
  decode(bytes: Uint8Array): StateFrame<InferData<S>>;
}

/** 由 component descriptor 派生狀態幀 codec（宣告一次，幀頭自動掛上） */
export function defineStateFrame<S extends ComponentSchema>(
  payload: ComponentDescriptor<S>
): StateFrameDescriptor<S> {
  return {
    encode(seq, rosterVer, data) {
      const w = new Writer();
      w.varint(seq);
      w.varint(rosterVer);
      const body = payload.encode(data);
      for (const b of body) w.u8(b);
      return w.finish();
    },
    decode(bytes) {
      const r = readerFrom(bytes);
      const seq = r.varint();
      const rosterVer = r.varint();
      const body = bytes.subarray(r.consumed);
      return { seq, rosterVer, data: payload.decode(body) };
    },
  };
}

/**
 * FrameGate — 收端 stale 幀丟棄。
 *
 * unreliable+unordered 通道下幀可能亂序抵達；只接受 seq 嚴格大於
 * 目前最新者，其餘視為 stale 丟棄（最新狀態已涵蓋）。
 */
export interface FrameGate {
  /** seq 比目前新 → 接受並推進；否則 stale → false */
  accept(seq: number): boolean;
  /** 目前最新 seq（尚未收過任何幀時為 -1） */
  latest(): number;
  /** 重置（重新開局／換場景時） */
  reset(): void;
}

export function createFrameGate(): FrameGate {
  let latestSeq = -1;
  return {
    accept(seq) {
      if (seq <= latestSeq) return false;
      latestSeq = seq;
      return true;
    },
    latest: () => latestSeq,
    reset() {
      latestSeq = -1;
    },
  };
}
