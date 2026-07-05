/**
 * 井字棋面板（UI demo：遊戲真的跑在 Nerilo 傳輸層上）
 *
 * 斷線 = 對局暫停（誠實降級）：遊戲事件只走 P2P 可靠通道、不走 Firestore
 * 備援（決策見 docs/game/transport-contract-M4.md）；P2P 斷線時雙方同時
 * 進暫停態，恢復後可 RESTART。
 */
import React from 'react';
import type { P2PChannelBus } from '../../core/p2p/P2PChannelBus';
import { useTicTacToe } from './useTicTacToe';
import './TicTacToePanel.css';

interface TicTacToePanelProps {
  bus: P2PChannelBus | null;
  isInitiator: boolean;
  selfId: string;
  /** P2P 連線是否活著；false 顯示暫停遮罩並鎖操作 */
  connected: boolean;
  onClose: () => void;
}

export function TicTacToePanel({
  bus,
  isInitiator,
  selfId,
  connected,
  onClose,
}: TicTacToePanelProps): React.ReactElement {
  const { state, myMark, play, restart } = useTicTacToe(bus, isInitiator, selfId);

  const status = state.winner
    ? state.winner === 'draw'
      ? '平手'
      : state.winner === myMark
        ? '你贏了！'
        : '對方獲勝'
    : state.turn === myMark
      ? `輪到你（${myMark}）`
      : `等待對方（${state.turn}）`;

  return (
    <div className="ttt-panel" role="region" aria-label="井字棋">
      <div className="ttt-header">
        <span className="ttt-title">井字棋</span>
        <span className="ttt-status" data-testid="ttt-status">
          {status}
        </span>
        <button type="button" className="ttt-close" onClick={onClose} aria-label="關閉遊戲">
          ✕
        </button>
      </div>

      <div className="ttt-board-wrap">
        <div className="ttt-board" role="grid" aria-label="棋盤">
          {state.board.map((cell, i) => (
            <button
              key={i}
              type="button"
              role="gridcell"
              className="ttt-cell"
              data-testid={`ttt-cell-${i}`}
              disabled={!connected || cell !== null || state.turn !== myMark || state.winner !== null}
              onClick={() => play(i)}
              aria-label={`第 ${i + 1} 格${cell ? `：${cell}` : ''}`}
            >
              {cell}
            </button>
          ))}
        </div>

        {!connected && (
          <div className="ttt-paused" role="status">
            連線中斷，對局暫停
          </div>
        )}
      </div>

      <button type="button" className="ttt-restart" onClick={restart} disabled={!connected}>
        重新開始
      </button>
    </div>
  );
}
