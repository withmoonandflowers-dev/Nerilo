// 角色定義
export type UserRole = 'guest' | 'user' | 'admin';

// 使用者資訊
export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  customClaims?: Record<string, any>;
}

// P2P 連線狀態
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

// P2P 房間
export interface P2PRoom {
  roomId: string;
  ownerUid: string;
  ownerName?: string; // 房主顯示名稱（顯示在公開房列表）
  participants: string[];
  status: 'waiting' | 'open' | 'closed'; // waiting: 等待其他人加入
  isPrivate: boolean;
  createdAt: number;
  waitingTimeout?: number; // 等待超時時間（毫秒），預設 5 分鐘
  waitingStartedAt?: number; // 開始等待的時間戳
  
  // 小網狀架構相關（可選）
  meshIdentities?: {
    [firebaseUid: string]: {
      userId: string; // hash(pubKey)
      pubKey: string; // Base64 編碼的公鑰
      joinedAt: number;
    };
  };
  
  topology?: 'star' | 'mesh'; // 預設 'star'
}

// Signaling 訊息
export interface Signal {
  signalId: string;
  from: string;
  to?: string;
  type: 'offer' | 'answer' | 'ice';
  payload: any;
  createdAt: number;
}

// 功能註冊
export interface Feature {
  featureId: string;
  name: string;
  description: string;
  enabled: boolean;
  requiredRoles: UserRole[];
  route: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
}

// P2P 協議 Envelope
export interface P2PEnvelope {
  v: number;
  ns: string;
  type: string;
  id: string;
  ts: number;
  from: string;
  to?: string;
  replyTo?: string;
  payload: any;
  meta?: Record<string, any>;
}

// 聊天訊息
export interface ChatMessage {
  messageId: string;
  from: string;
  to?: string;
  content: string;
  timestamp: number;
  edited?: boolean;
  deleted?: boolean;
}

// 檔案傳輸
export interface FileMetadata {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  chunkCount: number;
  chunkSize: number;
}

export interface FileTransferProgress {
  fileId: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
}

// 媒體狀態
export interface MediaState {
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
}

// 同步訊息
export interface SyncMessage {
  messageId: string;
  deviceId: string;
  timestamp: number;
  hash: string;
}

// Gossip 訊息（小網狀架構）
export interface GossipMessage {
  roomId: string;
  senderId: string; // hash(pubKey)
  pubKey: string; // Base64 編碼的公鑰
  seq: number; // 序列號（防止重放）
  timestamp: number;
  content: string;
  ttl: number; // Time To Live（跳數限制）
  signature: string; // Base64 編碼的簽名
}

// Mesh 身分資訊
export interface MeshIdentity {
  userId: string; // hash(pubKey)
  pubKey: string; // Base64 編碼的公鑰
  joinedAt: number;
}

// ========== 共享資料流（區塊鏈式） ==========

/** 共享資料流 payload：任意 JSON 可序列化，由業務層定義 */
export type SharedStreamPayload = Record<string, unknown>;

/** 帳本條目（類似區塊鏈的一筆 block） */
export interface LedgerEntry {
  index: number;
  previousHash: string;
  payloadHash: string;
  timestamp: number;
  creatorId: string;
  payload: SharedStreamPayload;
  signature?: string;
  entryHash: string;
}

/** 建立條目時傳入的資料（不含 entryHash，由 SharedDataStream 計算） */
export type LedgerEntryInput = Omit<LedgerEntry, 'entryHash'>;

/** 共享資料流設定 */
export interface SharedStreamConfig {
  roomId: string;
  creatorId: string;
  /** 創世條目的 previousHash，通常為 '0' 或固定字串 */
  genesisPreviousHash?: string;
  /** 單筆 payload 最大位元組（JSON 序列化後），預設 100KB */
  maxPayloadSize?: number;
  /** 本地鏈最大條目數，超過可拒絕 append 或由業務層裁切，預設 50000 */
  maxEntries?: number;
  /** append 速率限制：每秒最多幾筆（本地建立），預設 20 */
  appendRateLimitPerSecond?: number;
  /** entryHash / previousHash / payloadHash 預期為 64 字元 hex */
  hashHexLength?: number;
}



