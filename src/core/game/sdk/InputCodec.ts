/**
 * InputCodec — 熱路徑輸入壓縮
 *
 * INPUT 是全協議最頻繁的訊息（tickRate × 玩家數，每秒數十~上百則）。
 * 現有 GameInputPayload 走 JSON（peerId 字串 + actions 字串陣列 + axes 物件），
 * 一則約 50~70 bytes。本 codec 把它壓成個位數 bytes：
 *
 *   - peerId：不上線。由 DataChannel 來源推斷（decode 時外部傳入）。
 *   - actions：宣告時給固定動作集 → 上線只送 bitmask（≤8 動作 1 byte、≤16 用 2、≤32 用 4）。
 *   - axes：宣告時給 q8/i8 等 codec → 每軸 1 byte（量化）。
 *   - tick / seq：varint（小值省空間）。
 *
 * 決定性：所有 peer 用同一份 schema 建 codec，位元一致。動作集順序 = 宣告順序。
 *
 * 注意：tick/seq 這裡編「絕對值」的 varint。若要進一步壓縮，呼叫端可改送
 * 「相對上一 confirmed tick 的差值」——那是傳輸層策略，不屬本 codec 職責。
 */

import type { GameInputPayload } from './GameMessageTypes';
import { Writer, readerFrom, type FieldCodec } from './schema';

export interface InputSchema {
  /** 固定動作集，最多 32 個。上線化為 bitmask，順序即 bit 位。 */
  readonly actions: readonly string[];
  /** 類比軸 → 各自的 field codec（通常 q8）。鍵序即上線序。 */
  readonly axes: Readonly<Record<string, FieldCodec<number>>>;
}

export interface InputDescriptor {
  encode(input: GameInputPayload): Uint8Array;
  /** peerId 由 channel 推斷，decode 時外部提供 */
  decode(bytes: Uint8Array, peerId: string): GameInputPayload;
  /** 便於測試/監控：某輸入編碼後的 byte 數 */
  byteSize(input: GameInputPayload): number;
}

/** 依動作數決定 bitmask 佔幾 byte（1/2/4） */
function maskBytes(actionCount: number): 1 | 2 | 4 {
  if (actionCount <= 8) return 1;
  if (actionCount <= 16) return 2;
  return 4;
}

export function defineInput(schema: InputSchema): InputDescriptor {
  if (schema.actions.length > 32) {
    throw new RangeError(`InputCodec 動作集上限 32，得到 ${schema.actions.length}`);
  }
  const actionIndex = new Map<string, number>();
  schema.actions.forEach((a, i) => actionIndex.set(a, i));
  const nBytes = maskBytes(schema.actions.length);
  const axisKeys = Object.keys(schema.axes);

  const writeMask = (w: Writer, mask: number): void => {
    if (nBytes === 1) w.u8(mask & 0xff);
    else if (nBytes === 2) w.u16(mask & 0xffff);
    else w.u32(mask >>> 0);
  };

  return {
    encode(input) {
      const w = new Writer();
      w.varint(input.tick);
      w.varint(input.seq);
      let mask = 0;
      for (const a of input.actions) {
        const idx = actionIndex.get(a);
        if (idx !== undefined) mask |= 1 << idx;
        // 未宣告的動作靜默丟棄（跨版相容：舊 peer 不認的新動作不會炸）
      }
      writeMask(w, mask);
      for (const key of axisKeys) {
        schema.axes[key].write(w, input.axes[key] ?? 0);
      }
      return w.finish();
    },

    decode(bytes, peerId) {
      const r = readerFrom(bytes);
      const tick = r.varint();
      const seq = r.varint();
      const mask = nBytes === 1 ? r.u8() : nBytes === 2 ? r.u16() : r.u32();
      const actions: string[] = [];
      for (let i = 0; i < schema.actions.length; i++) {
        if (mask & (1 << i)) actions.push(schema.actions[i]);
      }
      const axes: Record<string, number> = {};
      for (const key of axisKeys) {
        axes[key] = schema.axes[key].read(r);
      }
      return { peerId, tick, seq, actions, axes };
    },

    byteSize(input) {
      return this.encode(input).byteLength;
    },
  };
}
