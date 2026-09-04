/**
 * Vue 聊天頁的 HTTP rendezvous cold signaling 接線。
 *
 * 從 pages/chat/[roomId].vue 拆出，集中處理 Spec 030 Q3 的位址優先序與
 * MeshChatService signaling factory 建立。沒有位址時回傳 undefined，讓既有
 * MeshGossipManager 維持動態使用 Firestore cold。
 */
import { MeshChatService } from '@legacy/core/messaging/MeshChatService'
import { createHttpSignaling } from '@legacy/sdk/httpSignaling'
import { readIntroducerHint } from '~/lib/introducerHint'
import { resolveRendezvousUrl } from '~/lib/rendezvousConfig'

export function useRendezvousSignaling() {
  const deploymentUrl = import.meta.env.VITE_RENDEZVOUS_URL as string | undefined

  function createMeshService(roomId: string, uid: string) {
    // 邀請資料、使用者設定、部署設定依序決定 HTTP cold。
    // 正式房籍仍使用 Firestore directory，不把無認證 HTTP 名冊當權威。
    const rendezvousUrl = resolveRendezvousUrl(roomId, deploymentUrl)
    const signalingFactory = rendezvousUrl ? createHttpSignaling(rendezvousUrl) : undefined
    return new MeshChatService(
      roomId,
      uid,
      undefined,
      signalingFactory,
      undefined,
      readIntroducerHint(roomId, uid),
    )
  }

  return { createMeshService }
}
