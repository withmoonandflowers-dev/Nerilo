/**
 * 井字棋 × Nerilo 傳輸接線（game-integration-spec §2 事件式）
 *
 * 遊戲自訂 namespace 'ttt' 直接騎 P2PChannelBus（可靠有序 + E2EE 自動）。
 * 我方出招：樂觀本地套用 → bus.send MOVE；對端 MOVE 到達 → 同一 reducer 套用。
 * RESTART 雙向皆可發起。角色固定：房主（initiator）= X 先手。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { P2PChannelBus } from '../../core/p2p/P2PChannelBus';
import type { P2PEnvelope } from '../../types';
import { generateUUID } from '../../utils/uuid';
import { logger } from '../../utils/logger';
import {
  applyMove,
  initialState,
  moveCount,
  sanitizeState,
  type Mark,
  type TicTacToeState,
} from './ticTacToe';

const GAME_NS = 'ttt';

export interface UseTicTacToeResult {
  state: TicTacToeState;
  myMark: Mark;
  /** 通道就緒且未斷線才可互動（斷線 = 對局暫停） */
  play: (cell: number) => void;
  restart: () => void;
}

export function useTicTacToe(
  bus: P2PChannelBus | null,
  isInitiator: boolean,
  selfId: string
): UseTicTacToeResult {
  const [state, setState] = useState<TicTacToeState>(initialState);
  const myMark: Mark = isInitiator ? 'X' : 'O';
  const busRef = useRef(bus);
  busRef.current = bus;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** effect 與 subscribe callback 需在 send 宣告前引用它 → 經 ref 間接 */
  const sendRef = useRef<((type: 'MOVE' | 'RESTART' | 'SYNC_REQ' | 'SYNC_STATE', payload?: unknown) => void) | null>(null);

  // 訂閱對端事件；bus 實例更換（重連）時重掛
  useEffect(() => {
    if (!bus) return;
    const unsubscribe = bus.subscribe(GAME_NS, async (env) => {
      if (env.from === selfId) return; // 自己送的（防未來 bus 語義改變）
      if (env.type === 'MOVE') {
        const { cell, mark } = (env.payload ?? {}) as { cell?: number; mark?: Mark };
        if (typeof cell !== 'number' || (mark !== 'X' && mark !== 'O')) return;
        // 對端只能下「對端的」棋——防偽造我方手
        if (mark === myMark) return;
        setState((s) => applyMove(s, cell, mark));
      } else if (env.type === 'RESTART') {
        setState(initialState());
      } else if (env.type === 'SYNC_REQ') {
        // 對方剛開面板：把我方盤面給它對齊（訂閱時序造成的漏事件由此補償）
        sendRef.current?.('SYNC_STATE', stateRef.current);
      } else if (env.type === 'SYNC_STATE') {
        const incoming = sanitizeState(env.payload);
        if (!incoming) return;
        // 手數多者為準：晚開面板的一方收斂到進行中的盤面；反向則 no-op
        setState((s) => (moveCount(incoming) > moveCount(s) ? incoming : s));
      }
    });
    return unsubscribe;
  }, [bus, selfId, myMark]);

  // 面板掛載（或重連拿到新 bus）時請求對齊盤面
  useEffect(() => {
    if (!bus) return;
    sendRef.current?.('SYNC_REQ');
  }, [bus]);

  const send = useCallback(
    (type: 'MOVE' | 'RESTART' | 'SYNC_REQ' | 'SYNC_STATE', payload?: unknown) => {
      const b = busRef.current;
      if (!b) return;
      const envelope: P2PEnvelope = {
        v: 1,
        ns: GAME_NS,
        type,
        id: generateUUID(),
        ts: Date.now(),
        from: selfId,
        // bus 驗證要求 payload 存在（undefined 整包被收端丟棄）
        payload: payload ?? {},
      } as P2PEnvelope;
      b.send(envelope).catch((error) => {
        // 可靠通道 send 失敗 = 連線已斷；UI 由 connectionState 進暫停態，
        // 此手在對端不存在——本地也不保留會更一致，但斷線瞬間的單手差
        // 由「雙方同時進暫停、恢復後 RESTART」的 UX 收斂（demo 取捨）。
        logger.warn('[useTicTacToe] send failed (connection lost?)', { type, error });
      });
    },
    [selfId]
  );
  sendRef.current = send;

  const play = useCallback(
    (cell: number) => {
      setState((s) => {
        if (s.turn !== myMark || s.winner !== null || s.board[cell] !== null) return s;
        const next = applyMove(s, cell, myMark);
        if (next !== s) send('MOVE', { cell, mark: myMark });
        return next;
      });
    },
    [myMark, send]
  );

  const restart = useCallback(() => {
    setState(initialState());
    send('RESTART');
  }, [send]);

  return { state, myMark, play, restart };
}
