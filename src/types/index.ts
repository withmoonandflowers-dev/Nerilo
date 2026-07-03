// 角色定義
export type UserRole = 'guest' | 'user' | 'admin';

// 使用者資訊
export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  customClaims?: Record<string, unknown>;
}

// P2P 連線狀態
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

// P2P 房間
export interface P2PRoom {
  roomId: string;
  roomName?: string; // 使用者自訂房間名稱（選填，顯示在房間卡片/標題）
  ownerUid: string;
  ownerName?: string; // 房主顯示名稱（顯示在公開房列表）
  participants: string[];
  status: 'waiting' | 'open' | 'closed' | 'closing' | 'migrating'; // waiting: 等待其他人加入
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

  topology?: 'star' | 'mesh' | 'hybrid' | 'auto'; // 預設 'star'

  // 待處理的合併請求 ID（由 roomRequests 集合管理）
  pendingMergeRequestId?: string;
  // 待處理的分岔計劃 ID（由 roomRequests 集合管理）
  pendingSplitPlanId?: string;

  // Extended lifecycle fields (new)
  participantCount?: number;
  version?: number;
  hostMigrationEpoch?: number;
  previousRoomId?: string | null;
  lineageRootRoomId?: string | null;
  capabilityHint?: RoomCapability;

  // Room TTL fields
  /** Last activity timestamp (updated on every message / join / leave) */
  lastActiveAt?: number;
  /** When the room should expire if idle. Set to lastActiveAt + TTL. */
  ttlExpireAt?: number;
}

// ========== 房間合併 / 分岔請求 ==========

/** 合併請求：Room A（source）想被 Room B（target）吸收 */
export interface RoomMergeRequest {
  requestId: string;
  type: 'merge';
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'expired';
  /** 發起合併的房間（將被關閉）*/
  sourceRoomId: string;
  sourceOwnerUid: string;
  /** 存活的目標房間 */
  targetRoomId: string;
  targetOwnerUid: string;
  createdAt: number;
  /** 請求過期時間（毫秒 epoch），預設 2 分鐘後 */
  expiresAt: number;
}

/**
 * 分岔計劃：房間 A 的部分成員分裂出去形成新房間 B
 *
 * 限制：
 *  - 只有 sourceOwnerUid 可以發起
 *  - newRoomOwnerUid 必須「目前沒有自己的房間」
 *  - participantsToSplit 必須都是 source 房間的現有成員
 *  - sourceOwnerUid 本身留在 source 房間（不能把自己分岔出去）
 */
export interface RoomSplitPlan {
  planId: string;
  type: 'split';
  status: 'pending' | 'accepted' | 'completed' | 'cancelled';
  /** 原始房間 */
  sourceRoomId: string;
  sourceOwnerUid: string;
  /** 被指定為新房間房主的成員（自己不能擁有其他房間） */
  newRoomOwnerUid: string;
  /** 要移動到新房間的成員列表（必須包含 newRoomOwnerUid）*/
  participantsToSplit: string[];
  /** 新房間 ID（completed 後填入）*/
  newRoomId?: string;
  createdAt: number;
  /** 計劃過期時間（毫秒 epoch），預設 5 分鐘後 */
  expiresAt: number;
}

// Signaling 訊息
export interface Signal {
  signalId: string;
  from: string;
  to?: string;
  type: 'offer' | 'answer' | 'ice';
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
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
  payload: unknown;
  meta?: Record<string, unknown>;
}

// 訊息傳送狀態
export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'failed';

// 聊天訊息
export interface ChatMessage {
  messageId: string;
  from: string;
  to?: string;
  content: string;
  timestamp: number;
  edited?: boolean;
  deleted?: boolean;
  hlc?: HLCTimestamp; // Hybrid Logical Clock（向下相容，optional）
  deliveryStatus?: DeliveryStatus;
  /**
   * 因果依賴：發送時的因果前緣（最近未被覆蓋的訊息 ID）。
   * 明文 metadata，即使 E2EE 也不加密（僅 messageId，不洩露內容）。
   * 存在（含空陣列）代表帶因果資訊，會經 CausalOrderingBuffer；
   * undefined 代表舊版訊息，直接遞交（向下相容）。
   */
  deps?: string[];
}

// ========== E2EE 加密聊天訊息 ==========

/** 透過 P2P 傳輸的加密聊天 payload（content 已加密） */
export interface EncryptedChatPayload {
  messageId: string;
  from: string;
  to?: string;
  timestamp: number;
  hlc?: HLCTimestamp;
  encrypted: {
    ciphertext: string; // Base64
    iv: string;         // Base64
    senderKeyEpoch: number;
    /** epoch 內單調遞增序號（重放防護）；舊版訊息可能缺少 */
    seq?: number;
  };
  /** 因果依賴（明文 metadata，不加密）；見 ChatMessage.deps */
  deps?: string[];
}

/** ECDH 公鑰交換 payload */
export interface ECDHPubKeyPayload {
  userId: string;
  ecdhPublicKey: string; // Base64 SPKI
}

/** Sender Key 分發 payload */
export interface SenderKeyDistPayload {
  senderId: string;
  epoch: number;
  ecdhPublicKey: string; // Base64 SPKI — sender 的 ECDH 公鑰
  encryptedKeys: Record<string, { encryptedKey: string; iv: string }>;
}

// 因果訊息（帶有依賴關係）
export interface CausalMessage extends ChatMessage {
  /** 發送時最近收到的 N 個訊息 ID（用於因果排序） */
  deps: string[];
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

// ========== Hybrid Logical Clock ==========

export interface HLCTimestamp {
  wallTime: number;
  logical: number;
  nodeId: string;
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
  hlc?: HLCTimestamp; // Hybrid Logical Clock（向下相容，optional）
}

// Mesh 身分資訊
export interface MeshIdentity {
  userId: string; // hash(pubKey)
  pubKey: string; // Base64 編碼的公鑰
  joinedAt: number;
}

// ========== 房間合併/分岔：Chain Marker Payload 型別 ==========

/**
 * Merge Marker：寫入 Room B 的主鏈，代表「Room A 被合併進來」
 * 寫入時機：Room B owner 呼叫 acceptMergeRequest() 時
 */
export interface ChainMergeMarkerPayload {
  _type: 'room:merged';
  /** 被合併的房間 ID（Room A）*/
  sourceRoomId: string;
  /** 合併完成的時間戳 */
  mergedAt: number;
  /** Room A 的 owner UID */
  sourceOwnerUid: string;
}

/**
 * Split-From Marker：寫入 Room B 的主鏈（第一筆條目），代表「我從 Room A 分岔出來」
 * 寫入時機：new Room B owner 呼叫 acceptSplitPlan() 時
 */
export interface ChainSplitFromMarkerPayload {
  _type: 'room:split_from';
  /** 原始房間 ID（Room A）*/
  sourceRoomId: string;
  /** 分岔的時間戳 */
  splitAt: number;
  /** 分岔時 Room A 的鏈長度（用來截取 provenance）*/
  sourceChainLength: number;
}

/**
 * Split-To Marker：寫入 Room A 的主鏈，代表「Room B 從我分岔出去了」
 * 寫入時機：Room A owner 偵測到 split completed 後
 */
export interface ChainSplitToMarkerPayload {
  _type: 'room:split_to';
  /** 新分岔出的房間 ID（Room B）*/
  targetRoomId: string;
  /** 移走的成員列表 */
  targetParticipants: string[];
  /** 分岔的時間戳 */
  splitAt: number;
}

// ========== Provenance（鏈血統）型別 ==========

/** Provenance 鏈的摘要（用於 P2P announce 訊息，不含完整 entries）*/
export interface ChainProvenanceSummary {
  /** 原始房間 ID */
  sourceRoomId: string;
  /** 如何繼承此鏈：merge = 合併進來；split = 分岔繼承 */
  operation: 'merge' | 'split';
  /** 原始鏈的條目數 */
  entryCount: number;
  /** 原始鏈最後一筆條目的 entryHash（用於驗證完整性）*/
  lastHash: string;
}

/** 帶有 provenance 標記的擴充條目（用於 getFullHistory() 顯示）*/
export interface LedgerEntryWithProvenance extends LedgerEntry {
  /** 是否為 provenance 條目（true = 來自另一個房間的歷史）*/
  isProvenance: boolean;
  /** 若為 provenance，記錄原始房間 ID */
  sourceRoomId?: string;
  /** 繼承方式 */
  provenanceOperation?: 'merge' | 'split';
}

// ========== P2P Provenance 同步訊息型別 ==========

/** 宣告自己擁有 provenance 鏈（連線建立後發送）*/
export interface ChainProvenanceAnnounce {
  type: 'chain-sync:provenance-announce';
  provenances: ChainProvenanceSummary[];
}

/** 請求某個 provenance 鏈的完整條目 */
export interface ChainProvenanceRequest {
  type: 'chain-sync:provenance-request';
  sourceRoomId: string;
}

/** 回覆 provenance 鏈的完整條目 */
export interface ChainProvenanceResponse {
  type: 'chain-sync:provenance-response';
  sourceRoomId: string;
  operation: 'merge' | 'split';
  entries: LedgerEntry[];
}

// ========== 共享資料流（區塊鏈式） ==========

/** 共享資料流 payload：任意 JSON 可序列化，由業務層定義 */
export type SharedStreamPayload = Record<string, unknown>;

/** 帳本條目（類似區塊鏈的一筆 block） */
export interface LedgerEntry<T = unknown> {
  index: number;
  previousHash: string;
  payloadHash: string;
  timestamp: number;
  creatorId: string;
  roomId?: string;
  epoch?: number;          // host migration epoch counter
  payloadType?: string;
  payload: T;
  nonce?: string;          // replay protection
  signature?: string;      // ed25519 or ECDSA
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

// ========== Room lifecycle & topology ==========

export type RoomStatus = 'waiting' | 'open' | 'closing' | 'closed' | 'migrating';
export type RoomTopology = 'star' | 'mesh' | 'hybrid' | 'auto';

export interface RoomCapability {
  features: string[];
  protocolVersion: number;
  maxPayloadBytes: number;
  supportsMesh: boolean;
  supportsMedia: boolean;
  supportsLedgerSnapshots: boolean;
}

// ========== Fork resolution ==========

export interface LedgerFork {
  parentHash: string;
  branches: LedgerEntry[];
  resolvedWinner?: LedgerEntry;
  orphans: LedgerEntry[];
}

// ========== Snapshot ==========

export interface LedgerSnapshot {
  snapshotId: string;
  roomId: string;
  upToIndex: number;
  tipHash: string;
  stateHash: string;
  createdAt: number;
  creatorId: string;
  chunks: string[];        // base64 serialized chunks
}

// ========== Web3 checkpoint ==========

export interface ChainCheckpoint {
  roomId: string;
  lineageRootRoomId: string;
  tipHash: string;
  height: number;
  snapshotHash?: string;
  submittedBy: string;
  submittedAt: number;
  chainId?: string;
  txHash?: string;
}

// ========== Multi-channel ==========

export type ChannelKind = 'control' | 'bulk' | 'gossip';

/** Message priority for backpressure queue */
export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';

// ========== Enhanced Envelope ==========

export interface Envelope<T = unknown> {
  v: number;
  ns: string;
  type: string;
  id: string;
  ts: number;
  from: string;
  to?: string;
  replyTo?: string;
  roomId: string;
  traceId?: string;
  hopCount?: number;
  ttl?: number;
  seq?: number;
  payload: T;
  meta?: Record<string, unknown>;
  sig?: string;
}

// ========== ACK tracking ==========

export interface PendingAck {
  envelopeId: string;
  peerId: string;
  sentAt: number;
  retryCount: number;
  deadline: number;
}

// ========== Feature plugin system ==========

export interface FeatureContext {
  selfId: string;
  roomId: string;
  send: (peerId: string, env: Envelope) => Promise<void>;
  broadcast: (env: Envelope) => Promise<void>;
  appendLedger: (payloadType: string, payload: unknown) => Promise<void>;
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface FeatureModule {
  name: string;
  version: string;
  namespaces: string[];
  capabilities: string[];
  setup(ctx: FeatureContext): Promise<void>;
  teardown(): Promise<void>;
  onPeerJoin?(peerId: string): Promise<void>;
  onPeerLeave?(peerId: string): Promise<void>;
  handleEnvelope?(env: Envelope): Promise<void>;
}

// ========== Host migration ==========

export interface HostMigrationEvent {
  roomId: string;
  oldOwnerUid: string;
  newOwnerUid: string;
  epoch: number;
  triggeredAt: number;
  reason: 'owner_left' | 'owner_timeout' | 'manual';
}



