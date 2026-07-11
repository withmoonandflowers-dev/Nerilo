/**
 * 五子棋純邏輯測試（與 ticTacToe 同構）——連 5 勝於四方向、applyMove 防禦、sanitize。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  initialState,
  moveCount,
  sanitizeState,
  BOARD_SIZE,
  CELLS,
  type GomokuState,
  type Mark,
} from '../../src/features/game/gomoku';

const idx = (r: number, c: number) => r * BOARD_SIZE + c;

/** 依序落子（交替 B/W 由 turn 決定）；回傳最終狀態。 */
function playSeq(cells: number[]): GomokuState {
  let s = initialState();
  for (const cell of cells) s = applyMove(s, cell, s.turn);
  return s;
}

/** 讓某一方連下 5 子成線：對手每手下在遠處不干擾。 */
function winLine(cells: number[], filler: number[]): GomokuState {
  let s = initialState();
  for (let i = 0; i < cells.length; i++) {
    s = applyMove(s, cells[i]!, s.turn); // B 下 cells[i]
    if (s.winner) break;
    if (i < filler.length) s = applyMove(s, filler[i]!, s.turn); // W 下 filler[i]
  }
  return s;
}

describe('gomoku — 基本', () => {
  it('初始盤：225 空格、黑先、無勝', () => {
    const s = initialState();
    expect(s.board).toHaveLength(CELLS);
    expect(s.turn).toBe('B');
    expect(s.winner).toBeNull();
    expect(moveCount(s)).toBe(0);
  });

  it('黑白交替落子推進 turn', () => {
    let s = initialState();
    s = applyMove(s, idx(7, 7), 'B');
    expect(s.board[idx(7, 7)]).toBe('B');
    expect(s.turn).toBe('W');
    s = applyMove(s, idx(7, 8), 'W');
    expect(s.turn).toBe('B');
  });
});

describe('gomoku — 勝負判定（四方向連 5）', () => {
  const filler = [idx(0, 0), idx(0, 1), idx(0, 2), idx(0, 3), idx(0, 4)];

  it('橫向連 5 → 黑勝', () => {
    const s = winLine([idx(7, 3), idx(7, 4), idx(7, 5), idx(7, 6), idx(7, 7)], filler);
    expect(s.winner).toBe('B');
  });

  it('直向連 5 → 黑勝', () => {
    const s = winLine([idx(3, 7), idx(4, 7), idx(5, 7), idx(6, 7), idx(7, 7)], filler);
    expect(s.winner).toBe('B');
  });

  it('右下斜連 5 → 黑勝', () => {
    const s = winLine([idx(3, 3), idx(4, 4), idx(5, 5), idx(6, 6), idx(7, 7)], filler);
    expect(s.winner).toBe('B');
  });

  it('左下斜連 5 → 黑勝', () => {
    const s = winLine([idx(3, 8), idx(4, 7), idx(5, 6), idx(6, 5), idx(7, 4)], filler);
    expect(s.winner).toBe('B');
  });

  it('只有 4 連 → 尚未勝', () => {
    const s = winLine([idx(7, 3), idx(7, 4), idx(7, 5), idx(7, 6)], filler);
    expect(s.winner).toBeNull();
  });

  it('勝負底定後不再接受落子', () => {
    let s = winLine([idx(7, 3), idx(7, 4), idx(7, 5), idx(7, 6), idx(7, 7)], filler);
    const before = s;
    s = applyMove(s, idx(9, 9), s.turn);
    expect(s).toBe(before); // no-op
  });
});

describe('gomoku — applyMove 防禦', () => {
  it('非該方回合 → no-op', () => {
    const s = initialState(); // turn=B
    expect(applyMove(s, idx(7, 7), 'W')).toBe(s);
  });
  it('已占格 → no-op', () => {
    const s = applyMove(initialState(), idx(7, 7), 'B');
    expect(applyMove(s, idx(7, 7), 'W')).toBe(s);
  });
  it('越界 cell → no-op', () => {
    const s = initialState();
    expect(applyMove(s, -1, 'B')).toBe(s);
    expect(applyMove(s, CELLS, 'B')).toBe(s);
  });
});

describe('gomoku — sanitizeState', () => {
  it('合法盤面重算 winner', () => {
    const s = playSeq([idx(7, 3), idx(0, 0), idx(7, 4), idx(0, 1), idx(7, 5), idx(0, 2), idx(7, 6), idx(0, 3), idx(7, 7)]);
    const clean = sanitizeState({ board: s.board, turn: s.turn });
    expect(clean).not.toBeNull();
    expect(clean!.winner).toBe('B'); // 重算出黑連 5
  });
  it('盤面長度錯 / turn 錯 / 非法棋子 → null', () => {
    expect(sanitizeState({ board: new Array(9).fill(null), turn: 'B' })).toBeNull();
    expect(sanitizeState({ board: new Array(CELLS).fill(null), turn: 'X' as Mark })).toBeNull();
    const bad = new Array(CELLS).fill(null); bad[0] = 'Z';
    expect(sanitizeState({ board: bad, turn: 'B' })).toBeNull();
    expect(sanitizeState(null)).toBeNull();
  });
});
