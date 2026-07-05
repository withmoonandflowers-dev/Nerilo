/**
 * 井字棋純邏輯（UI demo，game-integration-spec 里程碑 1）
 *
 * 事件式同步模型（spec §2）：狀態由「本地套用 + 對端 MOVE 事件套用」共同推進，
 * 傳輸層（可靠有序 bus）保證事件不丟不重不亂序，因此兩端 reducer 純函數
 * 且輸入序列相同 → 狀態必然一致，毋須額外對帳。
 */

export type Mark = 'X' | 'O';
export type Cell = Mark | null;

export interface TicTacToeState {
  board: Cell[]; // 長度 9，index 0-8 = 左上到右下
  turn: Mark; // 輪到誰
  winner: Mark | 'draw' | null;
}

export function initialState(): TicTacToeState {
  return { board: Array<Cell>(9).fill(null), turn: 'X', winner: null };
}

const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function computeWinner(board: Cell[]): Mark | 'draw' | null {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return board.every((c) => c !== null) ? 'draw' : null;
}

/** 已下子數：SYNC 對齊時「較多手的盤面」為準 */
export function moveCount(state: TicTacToeState): number {
  return state.board.filter((c) => c !== null).length;
}

/**
 * 驗證網路來的盤面形狀並重算 winner（不信任對端聲稱的勝負）。
 * 不合法回傳 null。信任邊界同 ADR-G01：擋壞資料，不防對端改自己 client。
 */
export function sanitizeState(raw: unknown): TicTacToeState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { board, turn } = raw as Partial<TicTacToeState>;
  if (!Array.isArray(board) || board.length !== 9) return null;
  if (!board.every((c) => c === null || c === 'X' || c === 'O')) return null;
  if (turn !== 'X' && turn !== 'O') return null;
  const cleanBoard = [...board] as Cell[];
  return { board: cleanBoard, turn, winner: computeWinner(cleanBoard) };
}

/**
 * 套用一手棋。非法輸入（非該方回合、格子已占、局已結束、cell 越界）
 * 回傳原狀態不變——這同時是對「惡意/亂序對端事件」的防禦：壞事件是 no-op。
 */
export function applyMove(state: TicTacToeState, cell: number, mark: Mark): TicTacToeState {
  if (state.winner !== null) return state;
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return state;
  if (state.turn !== mark) return state;
  if (state.board[cell] !== null) return state;

  const board = [...state.board];
  board[cell] = mark;
  return {
    board,
    turn: mark === 'X' ? 'O' : 'X',
    winner: computeWinner(board),
  };
}
