/**
 * IdentityPreRegistration — 身份預註冊與公鑰允許清單
 *
 * P2P 環境下，任何人只要知道 roomId 就能嘗試連線。
 * 這個模組實現「先註冊公鑰，再允許連線」的安全機制：
 *
 * 流程：
 *   1. 房主建立房間時產生允許清單（白名單模式）或開放註冊（開放模式）
 *   2. 玩家加入前，先將自己的 pubKey + userId 註冊到允許清單
 *   3. 進入 mesh 後，收到 GossipMessage 時比對 senderId 是否在清單中
 *   4. 不在清單中的 peer → 拒絕訊息 + 可選擇踢出
 *
 * 安全效果：
 *   - 防止未授權的 peer 冒充身份
 *   - 結合 IdentityManager 的 pubKey → userId 推導，形成雙重驗證
 *   - 允許清單可透過 Gossip 同步給所有節點（去中心化）
 */

import { logger } from '../../utils/logger';

/** 預註冊記錄 */
export interface RegistrationEntry {
  /** hash(pubKey) 推導出的 userId */
  userId: string;
  /** Base64 SPKI 公鑰 */
  pubKey: string;
  /** 註冊時間戳 */
  registeredAt: number;
  /** 註冊者的 Firebase UID（如果有的話） */
  firebaseUid?: string;
  /** 由誰批准的（開放模式下為 'self'） */
  approvedBy: string;
}

/** 註冊模式 */
export type RegistrationMode =
  | 'open'        // 任何人可自行註冊
  | 'invite-only' // 只有房主/管理員能加人
  | 'approval';   // 自行註冊，但需要管理員批准

/** 預註冊組態 */
export interface PreRegistrationConfig {
  /** 註冊模式（預設 open） */
  mode: RegistrationMode;
  /** 單一房間最大註冊數（預設 100） */
  maxRegistrations: number;
  /** 註冊有效期限（毫秒，預設 24 小時；0 = 不過期） */
  expiryMs: number;
}

const DEFAULT_CONFIG: PreRegistrationConfig = {
  mode: 'open',
  maxRegistrations: 100,
  expiryMs: 24 * 60 * 60 * 1000,
};

/** 驗證結果 */
export interface VerificationResult {
  /** 是否通過驗證 */
  allowed: boolean;
  /** 拒絕原因（如果被拒） */
  reason?: 'not-registered' | 'expired' | 'pubkey-mismatch' | 'pending-approval';
}

export class IdentityPreRegistration {
  private config: PreRegistrationConfig;
  private registry = new Map<string, RegistrationEntry>();
  /** 待審核的註冊（approval 模式用） */
  private pendingApprovals = new Map<string, RegistrationEntry>();
  /** 管理員清單（userId） */
  private admins = new Set<string>();
  /** 是否曾經有任何人成功註冊過（用於開放模式的向後相容判斷） */
  private hasEverRegistered = false;

  constructor(config?: Partial<PreRegistrationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 管理員 ───────────────────────────────────────────────────────────

  /** 將 userId 設為管理員 */
  addAdmin(userId: string): void {
    this.admins.add(userId);
  }

  /** 移除管理員 */
  removeAdmin(userId: string): void {
    this.admins.delete(userId);
  }

  /** 判斷是否為管理員 */
  isAdmin(userId: string): boolean {
    return this.admins.has(userId);
  }

  // ── 註冊 ─────────────────────────────────────────────────────────────

  /**
   * 註冊一個身份。
   *
   * @param userId   hash(pubKey) 推導的 userId
   * @param pubKey   Base64 SPKI 公鑰
   * @param requestedBy  發起註冊的人（open 模式 = userId 自己；invite-only = 管理員）
   * @returns 是否成功註冊（false = 被拒絕或容量已滿）
   */
  register(userId: string, pubKey: string, requestedBy: string, firebaseUid?: string): boolean {
    // 容量檢查
    if (this.registry.size >= this.config.maxRegistrations) {
      logger.warn('[IdentityPreRegistration] 註冊失敗：容量已滿', {
        userId,
        max: this.config.maxRegistrations,
      });
      return false;
    }

    // 模式檢查
    switch (this.config.mode) {
      case 'open':
        // 開放模式：誰都能註冊
        break;

      case 'invite-only':
        // 僅邀請：只有管理員能加人
        if (!this.admins.has(requestedBy)) {
          logger.warn('[IdentityPreRegistration] 註冊被拒：非管理員', {
            userId,
            requestedBy,
          });
          return false;
        }
        break;

      case 'approval':
        // 需審核：先放到待審區
        if (!this.admins.has(requestedBy)) {
          this.pendingApprovals.set(userId, {
            userId,
            pubKey,
            registeredAt: Date.now(),
            firebaseUid,
            approvedBy: '',
          });
          return true; // 註冊「受理」但尚未批准
        }
        break;
    }

    // 寫入正式清單
    this.registry.set(userId, {
      userId,
      pubKey,
      registeredAt: Date.now(),
      firebaseUid,
      approvedBy: requestedBy,
    });
    this.hasEverRegistered = true;

    return true;
  }

  /**
   * 管理員批准待審核的註冊。
   */
  approve(userId: string, adminId: string): boolean {
    if (!this.admins.has(adminId)) return false;

    const pending = this.pendingApprovals.get(userId);
    if (!pending) return false;

    this.pendingApprovals.delete(userId);
    this.registry.set(userId, {
      ...pending,
      approvedBy: adminId,
    });
    this.hasEverRegistered = true;

    return true;
  }

  /**
   * 管理員拒絕待審核的註冊。
   */
  reject(userId: string, adminId: string): boolean {
    if (!this.admins.has(adminId)) return false;
    return this.pendingApprovals.delete(userId);
  }

  /**
   * 移除已註冊的身份（踢出）。
   */
  revoke(userId: string): boolean {
    return this.registry.delete(userId);
  }

  // ── 驗證 ─────────────────────────────────────────────────────────────

  /**
   * 驗證一個 peer 是否被允許參與。
   *
   * @param userId  聲稱的 userId
   * @param pubKey  提供的 Base64 公鑰
   */
  verify(userId: string, pubKey: string): VerificationResult {
    const entry = this.registry.get(userId);

    // 開放模式且從未有人註冊時，允許通過（向後相容）
    // 注意：如果曾經有人註冊但後來都被 revoke，不走這個捷徑
    if (this.config.mode === 'open' && this.registry.size === 0 && !this.hasEverRegistered) {
      return { allowed: true };
    }

    if (!entry) {
      // 看看是不是在待審核中
      if (this.pendingApprovals.has(userId)) {
        return { allowed: false, reason: 'pending-approval' };
      }
      return { allowed: false, reason: 'not-registered' };
    }

    // 檢查有效期限
    if (this.config.expiryMs > 0) {
      const age = Date.now() - entry.registeredAt;
      if (age > this.config.expiryMs) {
        // 過期 → 自動移除
        this.registry.delete(userId);
        return { allowed: false, reason: 'expired' };
      }
    }

    // 比對公鑰
    if (entry.pubKey !== pubKey) {
      return { allowed: false, reason: 'pubkey-mismatch' };
    }

    return { allowed: true };
  }

  // ── 查詢 ─────────────────────────────────────────────────────────────

  /** 取得所有已註冊的 userId */
  getRegisteredUserIds(): string[] {
    return [...this.registry.keys()];
  }

  /** 取得待審核的 userId */
  getPendingUserIds(): string[] {
    return [...this.pendingApprovals.keys()];
  }

  /** 取得註冊記錄 */
  getEntry(userId: string): RegistrationEntry | undefined {
    return this.registry.get(userId);
  }

  /** 目前已註冊數量 */
  getRegisteredCount(): number {
    return this.registry.size;
  }

  /**
   * 匯出註冊清單（供 Gossip 同步用）。
   * 回傳可序列化的陣列。
   */
  exportRegistry(): RegistrationEntry[] {
    return [...this.registry.values()];
  }

  /**
   * 匯入遠端同步來的註冊清單。
   * 只接受不存在的條目（不覆蓋本地已有的）。
   */
  importRegistry(entries: RegistrationEntry[]): number {
    let imported = 0;
    for (const entry of entries) {
      if (!this.registry.has(entry.userId) && this.registry.size < this.config.maxRegistrations) {
        this.registry.set(entry.userId, entry);
        imported++;
      }
    }
    if (imported > 0) this.hasEverRegistered = true;
    return imported;
  }

  /** 清空所有狀態 */
  destroy(): void {
    this.registry.clear();
    this.pendingApprovals.clear();
    this.admins.clear();
    this.hasEverRegistered = false;
  }
}
