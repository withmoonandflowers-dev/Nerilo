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

import { logger } from '../../utils/logger';

// ── 型別 ─────────────────────────────────────────────────────────────────────

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
  /**
   * 社群捐贈 TURN 清單 URL（ADR-0012 P1）。same-origin 靜態 JSON
   * （PR 制登錄，git 審計），CSP connect-src 'self' 天然放行。
   * undefined = 停用此來源。
   */
  communityTurnUrl?: string;
  /** 覆寫 fetch（測試用） */
  fetchFn?: typeof fetch;
  /** 覆寫 RTCPeerConnection 工廠（健康探測測試用） */
  pcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
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
  /** 社群 TURN 清單快取（TTL 同 cacheTtlMs） */
  private cachedCommunity: CachedTurnCredentials | null = null;
  private communityFetchPromise: Promise<TurnServerConfig[]> | null = null;
  /**
   * 健康探測結果（urls 字串化 → 是否產出 relay candidate）。
   * 首次呼叫不阻塞（全部放行 + 背景探測），之後的呼叫過濾掉已知不健康者——
   * 死 TURN 對 ICE 無害只是浪費 gathering 時間，故不值得為它阻塞首連。
   */
  private communityHealth = new Map<string, boolean>();
  private probing = new Set<string>();

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

    // 4. 社群捐贈 TURN（ADR-0012 P1）——來源失敗一律靜默略過，不影響主流程
    if (this.config.communityTurnUrl) {
      try {
        const community = await this.getCommunityTurnServers();
        for (const turn of community) {
          const key = JSON.stringify(turn.urls);
          if (this.communityHealth.get(key) === false) continue; // 已知不健康 → 過濾
          if (!this.communityHealth.has(key)) this.probeCommunityServer(turn); // 背景探測，不阻塞
          servers.push({
            urls: turn.urls,
            username: turn.username,
            credential: turn.credential,
            credentialType: turn.credentialType ?? 'password',
          } as RTCIceServer);
        }
      } catch (err) {
        logger.warn('[IceServerProvider] Community TURN list unavailable, skipped', err);
      }
    }

    return servers;
  }

  /** 取社群 TURN 清單（same-origin JSON，帶快取與並行 dedup） */
  private async getCommunityTurnServers(): Promise<TurnServerConfig[]> {
    if (this.cachedCommunity && Date.now() < this.cachedCommunity.expiresAt) {
      return this.cachedCommunity.servers;
    }
    if (this.communityFetchPromise) return this.communityFetchPromise;

    this.communityFetchPromise = this.fetchCommunityList();
    try {
      const servers = await this.communityFetchPromise;
      this.cachedCommunity = { servers, expiresAt: Date.now() + this.config.cacheTtlMs };
      return servers;
    } finally {
      this.communityFetchPromise = null;
    }
  }

  private async fetchCommunityList(): Promise<TurnServerConfig[]> {
    const fetchFn = this.config.fetchFn ?? fetch;
    const response = await fetchFn(this.config.communityTurnUrl!, { method: 'GET' });
    if (!response.ok) throw new Error(`community TURN list fetch failed: ${response.status}`);
    const data = (await response.json()) as { servers?: unknown };
    if (!Array.isArray(data.servers)) return [];

    // 逐筆驗證：urls 必須是 turn:/turns:，帳密必須是字串——壞條目丟棄不擋全清單
    const valid: TurnServerConfig[] = [];
    for (const raw of data.servers) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const urls = Array.isArray(s.urls) ? s.urls : typeof s.urls === 'string' ? [s.urls] : null;
      if (
        urls &&
        urls.every((u) => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:'))) &&
        typeof s.username === 'string' &&
        typeof s.credential === 'string'
      ) {
        valid.push({ urls: urls as string[], username: s.username, credential: s.credential });
      } else {
        logger.warn('[IceServerProvider] Invalid community TURN entry skipped', { entry: s.urls });
      }
    }
    return valid;
  }

  /**
   * 背景健康探測：relay-only ICE gathering 是否在時限內產出 relay candidate。
   * 結果只影響「之後的」getIceServers 呼叫（首連不因探測而延遲）。
   */
  private probeCommunityServer(turn: TurnServerConfig, timeoutMs = 5_000): void {
    const key = JSON.stringify(turn.urls);
    if (this.probing.has(key)) return;
    this.probing.add(key);

    const pcFactory =
      this.config.pcFactory ??
      ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg));

    let pc: RTCPeerConnection | null = null;
    const finish = (healthy: boolean) => {
      if (!this.probing.has(key)) return; // 已 finish 過
      this.probing.delete(key);
      this.communityHealth.set(key, healthy);
      if (!healthy) {
        logger.warn('[IceServerProvider] Community TURN unhealthy, will be filtered', { urls: turn.urls });
      }
      try {
        pc?.close();
      } catch {
        /* noop */
      }
    };

    try {
      pc = pcFactory({
        iceServers: [
          {
            urls: turn.urls,
            username: turn.username,
            credential: turn.credential,
          } as RTCIceServer,
        ],
        iceTransportPolicy: 'relay', // 只允許 relay → 有 candidate 即證明 TURN 活著
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate.includes('relay')) {
          clearTimeout(timer);
          finish(true);
        }
      };
      pc.createDataChannel('turn-probe');
      pc.createOffer()
        .then((offer) => pc!.setLocalDescription(offer))
        .catch(() => {
          clearTimeout(timer);
          finish(false);
        });
    } catch {
      finish(false);
    }
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

  // 社群捐贈 TURN（ADR-0012 P1）：預設啟用 same-origin 登錄檔；
  // VITE_COMMUNITY_TURN=off 可停用。清單為空或 404 時靜默略過，零影響。
  if (import.meta.env?.VITE_COMMUNITY_TURN !== 'off') {
    config.communityTurnUrl = '/community-turn.json';
  }

  defaultProvider = new IceServerProvider(config);
  return defaultProvider;
}

/** 重設全域 provider（用於測試） */
export function resetIceServerProvider(): void {
  defaultProvider = null;
}
