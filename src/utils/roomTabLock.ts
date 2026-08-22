/**
 * 房間分頁互斥鎖（B1）。
 *
 * 為什麼需要：同一使用者開兩個分頁進同一房，在協定層上是「同一個節點」——
 * mesh senderId 來自 IndexedDB 裡的金鑰對、deviceId 存在 localStorage，兩者都跨分頁共用。
 * 兩頁同時參與時：
 *  - 同一毫秒配發會拿到相同 sessionEpoch，seq 跟著重疊，收端以
 *    (senderId, sessionEpoch, seq) 去重 → 其中一頁的訊息整批被當重複丟掉；
 *  - 就算 epoch 不同，收端只認 per-sender 現行代，較舊那頁一樣送不到。
 * 兩條路都是**靜默**失敗：使用者只看到訊息憑空消失。
 *
 * 真正要支援多分頁，得讓每頁有獨立身分——但 meshIdentities 是以 firebaseUid 為鍵的
 * map（一個 uid 只放得下一份身分），改動會連鎖到 rules、keyx 封裝與房間容量計算，
 * 屬協定層變更。在那之前，這裡選擇「一次只讓一個分頁參與，其餘誠實告知」。
 *
 * 用 Web Locks API：鎖與分頁生命週期綁定，分頁關閉/當掉由瀏覽器自動釋放，
 * 不會像 localStorage 旗標那樣留下需要逾時清理的孤兒鎖。
 */

export interface RoomTabLockHandle {
  /** 釋放鎖（或取消尚未完成的取得嘗試）。可重複呼叫。 */
  release(): void;
}

export interface RoomTabLockCallbacks {
  /** 取得鎖：本分頁是這個房間的作用分頁 */
  onAcquired: () => void;
  /** 鎖已被其他分頁持有：本分頁不應參與 mesh */
  onBusy: () => void;
}

/** Web Locks 不可用時（舊瀏覽器、非瀏覽器測試環境）視同取得，維持既有行為。 */
function locksUnavailable(): boolean {
  return typeof navigator === 'undefined' || !navigator.locks?.request;
}

export function roomTabLockName(roomId: string): string {
  return `nerilo.room.${roomId}`;
}

/**
 * 嘗試取得房間鎖。**不等待**：拿不到即刻以 onBusy 回報，
 * 讓 UI 立即說明「已在另一個分頁開啟」，而不是無限轉圈。
 */
export function acquireRoomTabLock(
  roomId: string,
  cb: RoomTabLockCallbacks
): RoomTabLockHandle {
  if (locksUnavailable()) {
    cb.onAcquired();
    return { release: () => undefined };
  }

  let releaseHeld: (() => void) | null = null;
  let released = false;

  void navigator.locks
    .request(roomTabLockName(roomId), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        cb.onBusy();
        return;
      }
      if (released) return; // 取得前就已被要求釋放（元件先卸載）
      cb.onAcquired();
      // 持有到 release() 被呼叫為止；callback 的 promise 未 settle 前鎖不釋放。
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    })
    .catch(() => {
      // 取鎖失敗（受限環境）不得擋住聊天：退回既有行為。
      if (!released) cb.onAcquired();
    });

  return {
    release: () => {
      released = true;
      releaseHeld?.();
      releaseHeld = null;
    },
  };
}
