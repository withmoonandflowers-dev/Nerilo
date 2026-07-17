/**
 * gameRoomFlag 測試（Spec 006 T3）——遊戲室旗標：一次性、跨房隔離、隱私模式降級。
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markOpenGameFlag, consumeOpenGameFlag } from '../../web-vue/app/lib/gameRoomFlag';

// node 環境無 sessionStorage：以記憶體 stub 模擬（web 語義）
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe('gameRoomFlag', () => {
  it('標記後恰好消費一次（讀完即清）', () => {
    markOpenGameFlag('r1');
    expect(consumeOpenGameFlag('r1')).toBe(true);
    expect(consumeOpenGameFlag('r1')).toBe(false); // 一次性
  });

  it('跨房隔離：r1 的旗標不影響 r2', () => {
    markOpenGameFlag('r1');
    expect(consumeOpenGameFlag('r2')).toBe(false);
    expect(consumeOpenGameFlag('r1')).toBe(true);
  });

  it('無旗標 → false', () => {
    expect(consumeOpenGameFlag('r-none')).toBe(false);
  });

  it('sessionStorage 不可用（隱私模式）→ 靜默降級不拋錯', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(() => markOpenGameFlag('r1')).not.toThrow();
    expect(consumeOpenGameFlag('r1')).toBe(false);
  });
});
