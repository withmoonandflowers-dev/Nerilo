/**
 * 房間訂閱控制器 — 對應 React 版 useRoomSubscription
 * 含 effectiveParticipantCount 的 Firestore 同步延遲補償邏輯，逐段對齊。
 */
import { RoomService } from '@legacy/services/RoomService'
import type { P2PRoom } from '@legacy/types'

export interface RoomSubscriptionCallbacks {
  onRoomClosed: () => void
  onRoomWaiting: (room: P2PRoom) => void
  onRoomOpen: (room: P2PRoom, effectiveParticipantCount: number) => void
  onRoomNotFound: () => void
}

export class RoomSubscriptionController {
  private lastParticipantCount = 0
  private unsubscribeFn: (() => void) | null = null

  private async calculateEffectiveParticipantCount(room: P2PRoom, roomId: string): Promise<number> {
    const currentCount = room.participants.length
    const lastCount = this.lastParticipantCount

    if (room.status === 'open' && lastCount >= 2 && currentCount < lastCount && lastCount > 0) {
      // 人數下降可能是快取舊值，強制讀 server
      const serverRoom = await RoomService.getRoom(roomId, true)
      if (serverRoom && serverRoom.participants.length !== currentCount) {
        const serverCount = serverRoom.participants.length
        const effective = room.status === 'open' && serverCount < 2 ? 2 : serverCount
        this.lastParticipantCount = effective
        return effective
      }
    }

    if (room.status === 'open' && currentCount < 2) {
      // open 至少代表曾有 2 人；讀到 <2 視為同步延遲
      this.lastParticipantCount = 2
      return 2
    }

    if (currentCount > lastCount || lastCount === 0) {
      this.lastParticipantCount = currentCount
    }
    return currentCount
  }

  async subscribe(roomId: string, callbacks: RoomSubscriptionCallbacks): Promise<void> {
    const initialRoom = await RoomService.getRoom(roomId, true)
    if (!initialRoom) {
      callbacks.onRoomNotFound()
      return
    }

    this.lastParticipantCount = initialRoom.participants.length
    if (initialRoom.status === 'open' && initialRoom.participants.length === 1) {
      this.lastParticipantCount = 2
    }

    this.unsubscribeFn = RoomService.subscribeRoom(roomId, async (updatedRoom) => {
      if (!updatedRoom) {
        callbacks.onRoomNotFound()
        return
      }
      if (updatedRoom.status === 'closed') {
        callbacks.onRoomClosed()
        return
      }
      if (updatedRoom.status === 'waiting') {
        callbacks.onRoomWaiting(updatedRoom)
        return
      }
      if (updatedRoom.status === 'open') {
        const effectiveCount = await this.calculateEffectiveParticipantCount(updatedRoom, roomId)
        callbacks.onRoomOpen(updatedRoom, effectiveCount)
      }
    })
  }

  unsubscribe(): void {
    this.unsubscribeFn?.()
    this.unsubscribeFn = null
    this.lastParticipantCount = 0
  }
}
