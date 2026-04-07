/**
 * ICE Server Provider
 *
 * 提供 STUN/TURN 伺服器配置，支援多種來源：
 * 1. 靜態配置（預設 STUN + 可選 TURN）
 * 2. Firebase Cloud Functions 動態取得（短期 TURN 憑證）
 * 3. 環境變數覆寫
 *
 * TURN 憑證有時效性（通常 24h），此 provider 會快取並自動更新。
 */

// ── 型別 ─────────────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';

export interface TurnServerConfig {
  urls: string | string[];
  username: string;
  credential: string;
  credentialType?: 'password';
}

export interface IceServerProviderConfig {
  /** 自訂 STUN URLs（覆蓋預設值） */
  stunUrls?: string[];
  /** 靜態 TURN 配置（用於自建 coturn 或固定帳密） */
  staticTurn?: TurnServerConfig[];
  /** 是否透過 Cloud Function 動態取得 TURN 憑證 */
  useDynamicTurn?: boolean;
  /** Cloud Function URL（預設使用 Firebase callable） */
  turnCredentialEndpoint?: string;
  /** TURN 憑證快取 TTL（毫秒），預設 12 小時 */
  cacheTtlMs?: number;
}

interface CachedTurnCredentials {
  servers: TurnServerConfig[];
  expiresAt: number;
}

// ── 預設值 ───────────────────────────────────────────────────────────────────

const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ── Provider ─────────────────────────────────────────────────────────────────

export class IceServerProvider {
  private config: Required<
    Pick<IceServerProviderConfig, 'stunUrls' | 'cacheTtlMs'>
  > & IceServerProviderConfig;

  private cachedTurn: CachedTurnCredentials | null = null;
  private fetchPromise: Promise<TurnServerConfig[]> | null = null;

  constructor(config: IceServerProviderConfig = {}) {
    this.config = {
      stunUrls: config.stunUrls ?? DEFAULT_STUN_SERVERS,
      cacheTtlMs: config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      ...config,
    };
  }

  /**
   * 取得完整的 ICE servers 配置（STUN + TURN）
   * 適合直接傳給 RTCPeerConnection constructor
   */
  async getIceServers(): Promise<RTCIceServer[]> {
    const servers: RTCIceServer[] = [];

    // 1. STUN servers
    for (const url of this.config.stunUrls) {
      servers.push({ urls: url });
    }

    // 2. 靜態 TURN（如果有）
    if (this.config.staticTurn) {
      for (const turn of this.config.staticTurn) {
        servers.push({
          urls: turn.urls,
          username: turn.username,
          credential: turn.credential,
          credentialType: turn.credentialType ?? 'password',
        } as RTCIceServer);
      }
    }

    // 3. 動態 TURN（Cloud Function）
    if (this.config.useDynamicTurn) {
      try {
        const dynamicTurn = await this.getDynamicTurnServers();
        for (const turn of dynamicTurn) {
          servers.push({
            urls: turn.urls,
            username: turn.username,
            credential: turn.credential,
            credentialType: turn.credentialType ?? 'password',
          } as RTCIceServer);
        }
      } catch (err) {
        logger.warn('[IceServerProvider] Failed to fetch dynamic TURN credentials, using STUN only', err);
      }
    }

    return servers;
  }

  /**
   * 從 Cloud Function 取得短期 TURN 憑證（帶快取）
   */
  private async getDynamicTurnServers(): Promise<TurnServerConfig[]> {
    // 檢查快取
    if (this.cachedTurn && Date.now() < this.cachedTurn.expiresAt) {
      return this.cachedTurn.servers;
    }

    // 避免並行請求（dedup）
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this.fetchTurnCredentials();

    try {
      const servers = await this.fetchPromise;
      this.cachedTurn = {
        servers,
        expiresAt: Date.now() + this.config.cacheTtlMs,
      };
      return servers;
    } finally {
      this.fetchPromise = null;
    }
  }

  /**
   * 實際從 Cloud Function 取得 TURN 憑證
   * 預期回傳格式：{ iceServers: [{ urls, username, credential }] }
   */
  private async fetchTurnCredentials(): Promise<TurnServerConfig[]> {
    const endpoint = this.config.turnCredentialEndpoint;
    if (!endpoint) {
      throw new Error('TURN credential endpoint not configured');
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`TURN credential fetch failed: ${response.status}`);
    }

    const data = await response.json();

    // 支援多種回傳格式
    const iceServers: TurnServerConfig[] =
      data.iceServers ?? data.result?.iceServers ?? [];

    // 只取 TURN servers
    return iceServers.filter(
      (s: TurnServerConfig) =>
        typeof s.urls === 'string'
          ? s.urls.startsWith('turn:') || s.urls.startsWith('turns:')
          : Array.isArray(s.urls) && s.urls.some(u => u.startsWith('turn:') || u.startsWith('turns:'))
    );
  }

  /** 清除快取（用於 credential rotation） */
  invalidateCache(): void {
    this.cachedTurn = null;
  }

  /** 取得目前快取狀態（用於除錯） */
  getCacheStatus(): { cached: boolean; expiresAt: number | null } {
    return {
      cached: this.cachedTurn !== null && Date.now() < (this.cachedTurn?.expiresAt ?? 0),
      expiresAt: this.cachedTurn?.expiresAt ?? null,
    };
  }
}

// ── 單例工廠（方便全域使用） ──────────────────────────────────────────────────

let defaultProvider: IceServerProvider | null = null;

/**
 * 取得全域 ICE server provider
 * 可透過環境變數配置：
 *   VITE_TURN_URLS - TURN server URLs（逗號分隔）
 *   VITE_TURN_USERNAME - TURN 帳號
 *   VITE_TURN_CREDENTIAL - TURN 密碼
 *   VITE_TURN_CREDENTIAL_ENDPOINT - 動態 TURN endpoint URL
 */
export function getIceServerProvider(): IceServerProvider {
  if (defaultProvider) return defaultProvider;

  const turnUrls = import.meta.env?.VITE_TURN_URLS;
  const turnUsername = import.meta.env?.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env?.VITE_TURN_CREDENTIAL;
  const turnEndpoint = import.meta.env?.VITE_TURN_CREDENTIAL_ENDPOINT;

  const config: IceServerProviderConfig = {};

  // 靜態 TURN 配置（從環境變數）
  if (turnUrls && turnUsername && turnCredential) {
    config.staticTurn = [
      {
        urls: turnUrls.split(',').map((u: string) => u.trim()),
        username: turnUsername,
        credential: turnCredential,
      },
    ];
  }

  // 動態 TURN 配置
  if (turnEndpoint) {
    config.useDynamicTurn = true;
    config.turnCredentialEndpoint = turnEndpoint;
  }

  defaultProvider = new IceServerProvider(config);
  return defaultProvider;
}

/** 重設全域 provider（用於測試） */
export function resetIceServerProvider(): void {
  defaultProvider = null;
}
