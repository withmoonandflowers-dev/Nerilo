/**
 * Firebase Realtime Database path helpers
 *
 * 集中管理所有 RTDB 路徑，避免 magic string 散落在各檔案中。
 */

export const RTDB = {
  /** 房間 metadata */
  room: (roomId: string) => `rooms/${roomId}`,
  /** 房間參與者（presence 用） */
  roomParticipant: (roomId: string, uid: string) => `rooms/${roomId}/participants/${uid}`,
  /** 所有房間根路徑 */
  rooms: () => 'rooms',

  /** WebRTC signaling */
  signals: (roomId: string) => `signals/${roomId}`,
  signal: (roomId: string, signalId: string) => `signals/${roomId}/${signalId}`,

  /** 訊息 relay（P2P fallback） */
  relay: (roomId: string) => `relay/${roomId}`,
  relayMessage: (roomId: string, msgId: string) => `relay/${roomId}/${msgId}`,

  /** 離線訊息 inbox */
  inbox: (roomId: string, uid: string) => `inbox/${roomId}/${uid}`,
  inboxMessage: (roomId: string, uid: string, msgId: string) => `inbox/${roomId}/${uid}/${msgId}`,

  /** 使用者 profile */
  user: (uid: string) => `users/${uid}`,

  /** 房間合併/分岔請求 */
  roomRequest: (id: string) => `roomRequests/${id}`,
  roomRequests: () => 'roomRequests',
} as const;
