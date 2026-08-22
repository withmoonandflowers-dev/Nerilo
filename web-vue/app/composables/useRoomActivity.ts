/**
 * 房間 metadata 的節流寫入（已讀水位、活躍度）。
 *
 * 自 chat/[roomId].vue 抽出：該頁是 god-file 棘輪的祖父檔，新功能進來前得先騰空間
 * （fitness.architecture.spec 的規則就是「要加功能請先拆檔」）。行為逐字不變：
 * 兩者都只寫房間文件的 metadata，聊天內容不經伺服器。
 */
import { RoomService } from '@legacy/services/RoomService'

const READ_THROTTLE_MS = 5_000
const ACTIVITY_THROTTLE_MS = 10_000

export function useRoomActivity(getRoomId: () => string, getUid: () => string | undefined) {
  let lastReadWriteAt = 0
  let lastBumpAt = 0

  /** 在房內看到訊息即已讀（節流 5s） */
  function touchRead(): void {
    const roomId = getRoomId()
    const uid = getUid()
    if (!uid || !roomId) return
    const now = Date.now()
    if (now - lastReadWriteAt < READ_THROTTLE_MS) return
    lastReadWriteAt = now
    RoomService.markRead(roomId, uid).catch(() => {})
  }

  /** 送訊後 bump 活躍度（節流 10s）：讓他人的列表排序與未讀點亮 */
  function touchActivity(): void {
    const roomId = getRoomId()
    if (!roomId) return
    const now = Date.now()
    if (now - lastBumpAt < ACTIVITY_THROTTLE_MS) return
    lastBumpAt = now
    RoomService.bumpActivity(roomId).catch(() => {})
  }

  return { touchRead, touchActivity }
}
