/**
 * 房間分頁互斥（B1）。
 *
 * 同一使用者開兩個分頁進同一房，在協定層上是同一個節點（mesh senderId 來自
 * IndexedDB 金鑰對、deviceId 存在 localStorage，皆跨分頁共用）。兩頁同時參與時
 * 其中一頁的訊息會被收端當重複默默丟掉——靜默失敗。在多裝置身分成為協定的一部分
 * 之前，一次只讓一個分頁參與，其餘誠實告知。機制細節見 @legacy/utils/roomTabLock。
 */
import { ref } from 'vue'
import { acquireRoomTabLock, type RoomTabLockHandle } from '@legacy/utils/roomTabLock'

export function useRoomTabLock() {
  /** 同一房已在別的分頁開著 → UI 應顯示提示並停止建立 mesh */
  const otherTabActive = ref(false)
  let handle: RoomTabLockHandle | null = null

  /** 嘗試成為此房的作用分頁。回傳 false 代表已被其他分頁佔用（不等待）。 */
  async function acquireTab(roomId: string): Promise<boolean> {
    handle?.release() // 前一次嘗試（多半是 onBusy）留下的 handle
    const ok = await new Promise<boolean>((resolve) => {
      handle = acquireRoomTabLock(roomId, {
        onAcquired: () => resolve(true),
        onBusy: () => resolve(false),
      })
    })
    otherTabActive.value = !ok
    return ok
  }

  function releaseTab(): void {
    handle?.release()
    handle = null
  }

  return { otherTabActive, acquireTab, releaseTab }
}
