/**
 * 井字棋純邏輯（UI demo 里程碑 1）
 * 事件式同步的正確性根基：同輸入序列 → 同狀態；壞事件 no-op。
 */
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  initialState,
  moveCount,
  sanitizeState,
  type TicTacToeState,
} from '../../src/features/game/ticTacToe';

function playSeq(moves: Array<[number, 'X' | 'O']>): TicTacToeState {
  return moves.reduce((s, [cell, mark]) => applyMove(s, cell, mark), initialState());
}

describe('ticTacToe 純邏輯', () => {
  it('X 先手、輪流交替', () => {
    let s = initialState();
    expect(s.turn).toBe('X');
    s = applyMove(s, 0, 'X');
    expect(s.board[0]).toBe('X');
    expect(s.turn).toBe('O');
  });

  it('非法事件全部 no-op：非該方回合 / 格子已占 / 越界 / 局已結束', () => {
    const s1 = applyMove(initialState(), 0, 'O'); // O 搶先
    expect(s1).toEqual(initialState());

    const s2 = playSeq([[0, 'X']]);
    expect(applyMove(s2, 0, 'O')).toBe(s2); // 已占
    expect(applyMove(s2, 9, 'O')).toBe(s2); // 越界
    expect(applyMove(s2, -1, 'O')).toBe(s2);
    expect(applyMove(s2, 1.5 as number, 'O')).toBe(s2);

    const ended = playSeq([
      [0, 'X'], [3, 'O'], [1, 'X'], [4, 'O'], [2, 'X'], // X 上排連線
    ]);
    expect(ended.winner).toBe('X');
    expect(applyMove(ended, 5, 'O')).toBe(ended); // 結束後 no-op
  });

  it('勝負判定：橫/直/斜/平手', () => {
    expect(playSeq([[0, 'X'], [3, 'O'], [1, 'X'], [4, 'O'], [2, 'X']]).winner).toBe('X');
    expect(playSeq([[0, 'X'], [1, 'O'], [3, 'X'], [4, 'O'], [8, 'X'], [7, 'O']]).winner).toBe('O'); // 直排 1-4-7
    expect(playSeq([[0, 'X'], [1, 'O'], [4, 'X'], [2, 'O'], [8, 'X']]).winner).toBe('X'); // 斜 0-4-8
    // 平手序列
    const draw = playSeq([
      [0, 'X'], [1, 'O'], [2, 'X'], [4, 'O'], [3, 'X'], [5, 'O'], [7, 'X'], [6, 'O'], [8, 'X'],
    ]);
    expect(draw.winner).toBe('draw');
  });

  it('同輸入序列 → 同狀態（兩端一致性的根基）', () => {
    const seq: Array<[number, 'X' | 'O']> = [[4, 'X'], [0, 'O'], [8, 'X'], [2, 'O']];
    expect(playSeq(seq)).toEqual(playSeq(seq));
  });

  it('sanitizeState：合法盤面通過並重算 winner；畸形回 null', () => {
    const s = playSeq([[0, 'X'], [3, 'O'], [1, 'X'], [4, 'O'], [2, 'X']]);
    // 對端聲稱沒人贏——不信，重算
    const cleaned = sanitizeState({ board: s.board, turn: s.turn, winner: null });
    expect(cleaned?.winner).toBe('X');

    expect(sanitizeState(null)).toBeNull();
    expect(sanitizeState({ board: [1, 2, 3], turn: 'X' })).toBeNull();
    expect(sanitizeState({ board: Array(9).fill('Z'), turn: 'X' })).toBeNull();
    expect(sanitizeState({ board: Array(9).fill(null), turn: 'Q' })).toBeNull();
    expect(sanitizeState({ board: Array(8).fill(null), turn: 'X' })).toBeNull();
  });

  it('moveCount 供 SYNC 對齊：手數多者為準', () => {
    expect(moveCount(initialState())).toBe(0);
    expect(moveCount(playSeq([[0, 'X'], [1, 'O']]))).toBe(2);
  });
});
