/**
 * ConnectionDiagnostics 測試（P2P 連線事件軌跡）
 *
 * - record 存事件、getRecent 取回
 * - 環形緩衝：超過容量丟最舊
 * - subscribe 通知 + 取消訂閱
 * - forwarder 擲錯不影響記錄
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { ConnectionDiagnostics } from '../../src/core/metrics/ConnectionDiagnostics';

describe('ConnectionDiagnostics', () => {
  it('record + getRecent 保序還原', () => {
    const d = new ConnectionDiagnostics();
    d.record('state:connecting');
    d.record('state:connected', { roomId: 'r1' });
    const events = d.getRecent();
    expect(events.map((e) => e.kind)).toEqual(['state:connecting', 'state:connected']);
    expect(events[1]!.detail).toEqual({ roomId: 'r1' });
    expect(typeof events[0]!.t).toBe('number');
  });

  it('環形緩衝：超過容量丟最舊', () => {
    const d = new ConnectionDiagnostics(3);
    d.record('a');
    d.record('b');
    d.record('c');
    d.record('d'); // 擠掉 a
    expect(d.getRecent().map((e) => e.kind)).toEqual(['b', 'c', 'd']);
  });

  it('getRecent(n) 取最近 n 筆', () => {
    const d = new ConnectionDiagnostics();
    ['a', 'b', 'c', 'd'].forEach((k) => d.record(k));
    expect(d.getRecent(2).map((e) => e.kind)).toEqual(['c', 'd']);
  });

  it('subscribe 收到事件，取消後不再收', () => {
    const d = new ConnectionDiagnostics();
    const seen: string[] = [];
    const unsub = d.subscribe((e) => seen.push(e.kind));
    d.record('x');
    unsub();
    d.record('y');
    expect(seen).toEqual(['x']);
  });

  it('forwarder 擲錯不影響記錄本身', () => {
    const d = new ConnectionDiagnostics();
    d.subscribe(() => {
      throw new Error('bad forwarder');
    });
    expect(() => d.record('z')).not.toThrow();
    expect(d.getRecent().map((e) => e.kind)).toEqual(['z']);
  });

  it('clear 清空', () => {
    const d = new ConnectionDiagnostics();
    d.record('a');
    d.clear();
    expect(d.getRecent()).toEqual([]);
  });

  it('無 detail 時 event 不帶 detail 欄位', () => {
    const d = new ConnectionDiagnostics();
    d.record('a');
    expect(d.getRecent()[0]).not.toHaveProperty('detail');
  });
});
