/**
 * 五子棋純邏輯（第二款回合制遊戲；與 ticTacToe.ts 同構、共用事件式同步模型）
 *
 * 同 ticTacToe 的信任邊界（ADR-G01）：reducer 純函數 + 可靠有序 bus → 兩端輸入序列
 * 相同即狀態一致，毋須對帳。sanitizeState 擋壞資料、重算 winner，不信任對端聲稱的勝負。
 *
 * 棋子：'B'（黑，先手＝initiator）/'W'（白）。盤面 15×15，橫/直/兩斜任一方向連 5 即勝。
 */

export const BOARD_SIZE = 15;
export const CELLS = BOARD_SIZE * BOARD_SIZE; // 225
export const WIN_LEN = 5;

export type Mark = 'B' | 'W';
export type Cell = Mark | null;

export interface GomokuState {
  board: Cell[]; // 長度 225，index = row*15 + col
  turn: Mark; // 輪到誰（黑先）
  winner: Mark | 'draw' | null;
}

export function initialState(): GomokuState {
  return { board: Array<Cell>(CELLS).fill(null), turn: 'B', winner: null };
}

/** 四個方向：右、下、右下、左下（只需正向掃，反向由別的起點涵蓋）。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function computeWinner(board: Cell[]): Mark | 'draw' | null {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const m = board[r * BOARD_SIZE + c];
      if (!m) continue;
      for (const [dr, dc] of DIRS) {
        // 檢查 (r,c) 起、沿 dir 的連續 5 子是否同色且皆在盤內。
        const endR = r + dr * (WIN_LEN - 1);
        const endC = c + dc * (WIN_LEN - 1);
        if (endR < 0 || endR >= BOARD_SIZE || endC < 0 || endC >= BOARD_SIZE) continue;
        let win = true;
        for (let k = 1; k < WIN_LEN; k++) {
          if (board[(r + dr * k) * BOARD_SIZE + (c + dc * k)] !== m) {
            win = false;
            break;
          }
        }
        if (win) return m;
      }
    }
  }
  return board.every((x) => x !== null) ? 'draw' : null;
}

/** 已下子數：SYNC 對齊時「較多手的盤面」為準。 */
export function moveCount(state: GomokuState): number {
  return state.board.filter((c) => c !== null).length;
}

/** 驗證網路來的盤面形狀並重算 winner；不合法回 null。 */
export function sanitizeState(raw: unknown): GomokuState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { board, turn } = raw as Partial<GomokuState>;
  if (!Array.isArray(board) || board.length !== CELLS) return null;
  if (!board.every((c) => c === null || c === 'B' || c === 'W')) return null;
  if (turn !== 'B' && turn !== 'W') return null;
  const cleanBoard = [...board] as Cell[];
  return { board: cleanBoard, turn, winner: computeWinner(cleanBoard) };
}

/**
 * 套用一手棋。非法輸入（非該方回合、格子已占、局已結束、cell 越界）回傳原狀態不變
 * ——同時是對亂序/惡意對端事件的防禦：壞事件是 no-op。
 */
export function applyMove(state: GomokuState, cell: number, mark: Mark): GomokuState {
  if (state.winner !== null) return state;
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return state;
  if (state.turn !== mark) return state;
  if (state.board[cell] !== null) return state;

  const board = [...state.board];
  board[cell] = mark;
  return {
    board,
    turn: mark === 'B' ? 'W' : 'B',
    winner: computeWinner(board),
  };
}
