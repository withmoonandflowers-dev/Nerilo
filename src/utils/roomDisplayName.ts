import type { P2PRoom } from '../types';

/**
 * 房間顯示名稱：優先用使用者自訂的 roomName，否則退回截斷的 ID。
 * 統一給 Dashboard / 等待室 / 聊天室標題使用，避免各處硬編碼 fallback。
 */
export function roomDisplayName(
  room: Pick<P2PRoom, 'roomName' | 'roomId'> | { roomName?: string; roomId?: string }
): string {
  const name = room.roomName?.trim();
  if (name) return name;
  const id = room.roomId ?? '';
  return `房間 ${id.substring(0, 8)}`;
}
