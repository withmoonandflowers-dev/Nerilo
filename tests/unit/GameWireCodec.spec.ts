/**
 * Game Wire 格式測試（ADR-0018）
 *
 * 重點驗證三件事：
 *   1. round-trip：encode → decode 還原（q8 量化容許誤差）
 *   2. 決定性：同輸入 → 同 bytes；跨 codec 實例 → 同 bytes（lockstep 命脈）
 *   3. 省頻寬：INPUT 壓縮後遠小於等效 JSON
 */

import { describe, it, expect } from 'vitest';
import {
  defineComponent,
  u8,
  u16,
  i16,
  f32,
  varint,
  bool,
  str,
  q8,
  Writer,
  readerFrom,
} from '../../src/core/game/sdk/schema';
import { defineInput } from '../../src/core/game/sdk/InputCodec';
import type { GameInputPayload } from '../../src/core/game/sdk/GameMessageTypes';

// ══════════════════════════════════════════════════════════════════════════════
// 二進位原語
// ══════════════════════════════════════════════════════════════════════════════

describe('Writer/Reader — 原語 round-trip', () => {
  it('varint 覆蓋單/雙/多 byte 邊界', () => {
    const cases = [0, 1, 127, 128, 300, 16383, 16384, 1_000_000];
    const w = new Writer();
    for (const v of cases) w.varint(v);
    const r = readerFrom(w.finish());
    for (const v of cases) expect(r.varint()).toBe(v);
  });

  it('varint 拒絕負數與非整數', () => {
    expect(() => new Writer().varint(-1)).toThrow();
    expect(() => new Writer().varint(1.5)).toThrow();
  });

  it('固定寬度整數與浮點還原', () => {
    const w = new Writer();
    w.u8(250);
    w.u16(60000);
    w.i16(-30000);
    w.f32(3.5);
    w.f64(Math.PI);
    const r = readerFrom(w.finish());
    expect(r.u8()).toBe(250);
    expect(r.u16()).toBe(60000);
    expect(r.i16()).toBe(-30000);
    expect(r.f32()).toBeCloseTo(3.5, 5);
    expect(r.f64()).toBe(Math.PI);
  });

  it('字串（UTF-8，含中文）還原', () => {
    const w = new Writer();
    w.str('hello 世界 🎮');
    expect(readerFrom(w.finish()).str()).toBe('hello 世界 🎮');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// defineComponent
// ══════════════════════════════════════════════════════════════════════════════

describe('defineComponent — 宣告一次派生 encode/decode/validate', () => {
  const Position = defineComponent('pos', { x: f32, y: f32 });
  const Health = defineComponent('health', { current: u16, max: u16, alive: bool });

  it('round-trip 還原欄位', () => {
    const p = { x: 12.5, y: -8.25 };
    const back = Position.decode(Position.encode(p));
    expect(back.x).toBeCloseTo(12.5, 4);
    expect(back.y).toBeCloseTo(-8.25, 4);
  });

  it('多型別欄位還原', () => {
    const h = { current: 75, max: 100, alive: true };
    expect(Health.decode(Health.encode(h))).toEqual(h);
  });

  it('validate 擋掉型別不符', () => {
    expect(Health.validate({ current: 1, max: 2, alive: false })).toBe(true);
    expect(Health.validate({ current: '1', max: 2, alive: false })).toBe(false);
    expect(Health.validate({ current: 1, max: 2 })).toBe(false);
    expect(Health.validate(null)).toBe(false);
  });

  it('決定性：同資料 → 同 bytes', () => {
    const p = { x: 1.23, y: 4.56 };
    expect(Array.from(Position.encode(p))).toEqual(Array.from(Position.encode(p)));
  });

  it('決定性：跨 descriptor 實例（同 schema）→ 同 bytes', () => {
    const A = defineComponent('pos', { x: f32, y: f32 });
    const B = defineComponent('pos', { x: f32, y: f32 });
    const p = { x: 9.99, y: -0.01 };
    expect(Array.from(A.encode(p))).toEqual(Array.from(B.encode(p)));
  });

  it('固定寬度 component 的 wire 大小可預測', () => {
    // f32 + f32 = 8 bytes，無長度前綴
    expect(Position.encode({ x: 0, y: 0 }).byteLength).toBe(8);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// q8 量化
// ══════════════════════════════════════════════════════════════════════════════

describe('q8 — 量化浮點', () => {
  const axis = q8(-1, 1);

  it('端點與中點還原在精度內', () => {
    const enc = (v: number) => {
      const w = new Writer();
      axis.write(w, v);
      return axis.read(readerFrom(w.finish()));
    };
    expect(enc(-1)).toBeCloseTo(-1, 5);
    expect(enc(1)).toBeCloseTo(1, 5);
    expect(enc(0)).toBeCloseTo(0, 1); // 精度 2/255 ≈ 0.0078
  });

  it('超出範圍夾住', () => {
    const w = new Writer();
    axis.write(w, 5);
    expect(axis.read(readerFrom(w.finish()))).toBeCloseTo(1, 5);
  });

  it('恰好 1 byte', () => {
    const w = new Writer();
    axis.write(w, 0.5);
    expect(w.finish().byteLength).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// InputCodec — 熱路徑
// ══════════════════════════════════════════════════════════════════════════════

describe('InputCodec — 熱路徑輸入壓縮', () => {
  const input = defineInput({
    actions: ['up', 'down', 'left', 'right', 'fire'],
    axes: { moveX: q8(-1, 1), moveY: q8(-1, 1) },
  });

  const sample: GameInputPayload = {
    peerId: 'alice-abcdef123456',
    tick: 142,
    seq: 9,
    actions: ['up', 'fire'],
    axes: { moveX: 0.5, moveY: -0.25 },
  };

  it('round-trip 還原（peerId 由外部帶入）', () => {
    const back = input.decode(input.encode(sample), sample.peerId);
    expect(back.peerId).toBe(sample.peerId);
    expect(back.tick).toBe(142);
    expect(back.seq).toBe(9);
    expect(back.actions).toEqual(['up', 'fire']); // 依宣告順序
    expect(back.axes.moveX).toBeCloseTo(0.5, 1);
    expect(back.axes.moveY).toBeCloseTo(-0.25, 1);
  });

  it('空輸入也能還原', () => {
    const empty: GameInputPayload = { peerId: 'bob', tick: 0, seq: 0, actions: [], axes: {} };
    const back = input.decode(input.encode(empty), 'bob');
    expect(back.actions).toEqual([]);
    expect(back.tick).toBe(0);
  });

  it('全動作按下 → bitmask 全開', () => {
    const all: GameInputPayload = {
      peerId: 'c',
      tick: 1,
      seq: 1,
      actions: ['up', 'down', 'left', 'right', 'fire'],
      axes: { moveX: 0, moveY: 0 },
    };
    expect(input.decode(input.encode(all), 'c').actions).toEqual(['up', 'down', 'left', 'right', 'fire']);
  });

  it('未宣告的動作被靜默丟棄（跨版相容）', () => {
    const withUnknown: GameInputPayload = {
      peerId: 'd',
      tick: 1,
      seq: 1,
      actions: ['up', 'teleport'], // teleport 不在 schema
      axes: { moveX: 0, moveY: 0 },
    };
    expect(input.decode(input.encode(withUnknown), 'd').actions).toEqual(['up']);
  });

  it('決定性：同輸入 → 同 bytes；跨 codec 實例一致', () => {
    const a = defineInput({ actions: ['up', 'fire'], axes: { x: q8(-1, 1) } });
    const b = defineInput({ actions: ['up', 'fire'], axes: { x: q8(-1, 1) } });
    const p: GameInputPayload = { peerId: 'z', tick: 5, seq: 2, actions: ['fire'], axes: { x: 0.3 } };
    expect(Array.from(a.encode(p))).toEqual(Array.from(a.encode(p)));
    expect(Array.from(a.encode(p))).toEqual(Array.from(b.encode(p)));
  });

  it('省頻寬：壓縮後 << 等效 JSON', () => {
    const size = input.byteSize(sample);
    // tick(varint 1~2) + seq(1) + mask(1) + 2軸(各1) = 個位數 bytes
    expect(size).toBeLessThanOrEqual(8);
    const jsonSize = new TextEncoder().encode(JSON.stringify(sample)).byteLength;
    expect(size).toBeLessThan(jsonSize / 5); // 至少省 80%
  });

  it('動作集 >8 用寬 bitmask 仍正確', () => {
    const wide = defineInput({
      actions: Array.from({ length: 12 }, (_, i) => `a${i}`),
      axes: {},
    });
    const p: GameInputPayload = { peerId: 'w', tick: 1, seq: 1, actions: ['a0', 'a9', 'a11'], axes: {} };
    expect(wide.decode(wide.encode(p), 'w').actions).toEqual(['a0', 'a9', 'a11']);
  });

  it('拒絕動作集 >32', () => {
    expect(() => defineInput({ actions: Array.from({ length: 33 }, (_, i) => `a${i}`), axes: {} })).toThrow();
  });
});

// unused import guard（i16 已在原語測試用到；保留 varint 匯出檢查）
describe('匯出健全性', () => {
  it('varint field codec 可獨立使用', () => {
    const w = new Writer();
    varint.write(w, 300);
    expect(varint.read(readerFrom(w.finish()))).toBe(300);
    // u8 / i16 亦為公開 codec
    expect(typeof u8.kind).toBe('string');
    expect(typeof i16.kind).toBe('string');
    expect(str.validate('x')).toBe(true);
  });
});
