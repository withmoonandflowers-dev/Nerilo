/**
 * RoomHeartbeat — 房主活性心跳（房間生命週期反映真實使用狀態）
 *
 * 解決兩個問題（一個機制）：
 * 1. 活房被 TTL 誤殺：聊天走 P2P 不碰 Firestore，ttlExpireAt 只在 join/leave
 *    刷新——長聊 30 分鐘後原生 TTL 會刪掉「使用中」的房間。心跳讓活房的
 *    TTL 永遠在未來。
 * 2. 殭屍房掛在公開列表：關分頁不觸發 leaveRoom，房間停在 open 直到原生
 *    TTL 刪除（最長 ~24h 延遲）。心跳停止 → 30 分鐘內 ttlExpireAt 過期 →
 *    公開列表查詢以 ttlExpireAt > now 立即濾掉，不等實際刪除。
 *
 * 設計：
 * - 只有房主跳（rules 現況房主可 update，零 rules 改動）；房主斷線由
 *   host migration 選出新房主接手心跳，機制閉環。
 * - 寫入失敗只警告不中斷（暫時離線屬正常，下一輪再試）。
 * - 成本：每活躍房 12 寫/小時。
 */

import { doc, updateDoc, Timestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { logger } from '../utils/logger';

/** 持久聊天室（2026-07-05 產品決策）：與 RoomService.PERSISTENT_TTL_MS 一致，
 *  心跳只刷新 lastActiveAt，不再把 ttl 縮回 30 分鐘（那會讓持久房被 TTL 政策誤殺） */
const OPEN_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
/** 心跳間隔：5 分鐘（TTL 的 1/6，單次失敗仍有多輪補救機會） */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface RoomHeartbeatOptions {
  /** 心跳間隔（測試用），預設 5 分鐘 */
  intervalMs?: number;
  /** 覆寫寫入函式（測試用），預設寫 Firestore 房間文件 */
  writeFn?: (roomId: string) => Promise<void>;
}

async function defaultWrite(roomId: string): Promise<void> {
  const now = Date.now();
  await updateDoc(doc(db, 'p2pRooms', roomId), {
    lastActiveAt: now,
    ttlExpireAt: Timestamp.fromMillis(now + OPEN_TTL_MS),
  });
}

/**
 * 啟動房主心跳：立即跳一次，之後每 intervalMs 跳一次。
 * 回傳 stop 函式（離開房間 / 失去房主身分 / unmount 時呼叫）。
 *
 * 呼叫端負責「只在自己是房主且在房內時」啟動——本模組不做身分判斷。
 */
export function startRoomHeartbeat(
  roomId: string,
  options: RoomHeartbeatOptions = {}
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const writeFn = options.writeFn ?? defaultWrite;
  let stopped = false;

  const beat = () => {
    if (stopped) return;
    writeFn(roomId).catch((err) => {
      // 暫時離線 / 權限競態（房主剛易主）都屬正常，警告後等下一輪
      logger.warn('[RoomHeartbeat] beat failed, will retry next interval', { roomId, err });
    });
  };

  beat(); // 立即跳一次（把剛進房的 TTL 推到未來）
  const timer = setInterval(beat, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
