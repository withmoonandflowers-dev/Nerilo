import { introducerStoreKey } from '@legacy/core/p2p/InviteRendezvous'

/**
 * 讀 waiting 頁暫存的介紹人 uid（Spec 005 T4 邀請會合）。
 * 無暫存／壞資料／隱私模式／指到自己 → undefined（一般冷啟動）。
 */
export function readIntroducerHint(roomId: string, selfUid: string): string | undefined {
  try {
    const raw = sessionStorage.getItem(introducerStoreKey(roomId))
    if (!raw) return undefined
    const { uid } = JSON.parse(raw) as { uid?: unknown }
    return typeof uid === 'string' && uid.length > 0 && uid !== selfUid ? uid : undefined
  } catch {
    return undefined
  }
}
