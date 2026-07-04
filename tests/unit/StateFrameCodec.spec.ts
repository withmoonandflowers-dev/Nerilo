/**
 * StateFrameCodec 測試（ADR-0019）
 *
 * - 幀 round-trip：seq + rosterVer + component payload 還原
 * - FrameGate：亂序抵達時 stale 幀被丟、新幀被收
 * - 決定性：同輸入 → 同 bytes（與 ADR-0018 一致的紅線）
 */

import { describe, it, expect } from 'vitest';
import { defineComponent, f32, u16, q8 } from '../../src/core/game/sdk/schema';
import { defineStateFrame, createFrameGate } from '../../src/core/game/sdk/StateFrameCodec';

const Snapshot = defineComponent('snap', {
  x: f32,
  y: f32,
  hp: u16,
  aim: q8(-1, 1),
});
const frame = defineStateFrame(Snapshot);

describe('defineStateFrame — 幀 round-trip', () => {
  it('seq / rosterVer / payload 全還原', () => {
    const data = { x: 10.5, y: -3.25, hp: 87, aim: 0.5 };
    const back = frame.decode(frame.encode(142, 7, data));
    expect(back.seq).toBe(142);
    expect(back.rosterVer).toBe(7);
    expect(back.data.x).toBeCloseTo(10.5, 4);
    expect(back.data.y).toBeCloseTo(-3.25, 4);
    expect(back.data.hp).toBe(87);
    expect(back.data.aim).toBeCloseTo(0.5, 1);
  });

  it('大 seq（varint 多 byte）仍正確', () => {
    const back = frame.decode(frame.encode(1_000_000, 300, { x: 0, y: 0, hp: 0, aim: 0 }));
    expect(back.seq).toBe(1_000_000);
    expect(back.rosterVer).toBe(300);
  });

  it('決定性：同輸入 → 同 bytes', () => {
    const data = { x: 1.5, y: 2.5, hp: 10, aim: -0.3 };
    expect(Array.from(frame.encode(5, 1, data))).toEqual(Array.from(frame.encode(5, 1, data)));
  });

  it('幀大小可預測：頭(2 varint) + f32*2 + u16 + q8 = 小於 16 bytes', () => {
    const bytes = frame.encode(60, 1, { x: 100.5, y: -200.25, hp: 999, aim: 1 });
    expect(bytes.byteLength).toBeLessThan(16); // 60Hz 每幀個位數~十幾 bytes
  });
});

describe('createFrameGate — stale 幀丟棄', () => {
  it('遞增 seq 全收', () => {
    const gate = createFrameGate();
    expect(gate.accept(1)).toBe(true);
    expect(gate.accept(2)).toBe(true);
    expect(gate.accept(3)).toBe(true);
    expect(gate.latest()).toBe(3);
  });

  it('亂序抵達：落後的幀被丟（下一幀天然覆蓋）', () => {
    const gate = createFrameGate();
    expect(gate.accept(5)).toBe(true);
    expect(gate.accept(3)).toBe(false); // 遲到的舊幀
    expect(gate.accept(5)).toBe(false); // 重複
    expect(gate.accept(6)).toBe(true);
    expect(gate.latest()).toBe(6);
  });

  it('seq 0 也能作為第一幀', () => {
    const gate = createFrameGate();
    expect(gate.accept(0)).toBe(true);
  });

  it('reset 後重新接受低 seq（換場景/重開局）', () => {
    const gate = createFrameGate();
    gate.accept(100);
    gate.reset();
    expect(gate.latest()).toBe(-1);
    expect(gate.accept(1)).toBe(true);
  });
});
