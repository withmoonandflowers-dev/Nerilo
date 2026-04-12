/**
 * IceServerProvider 單元測試
 *
 * 驗證 STUN/TURN 伺服器配置邏輯：
 *  - 預設只有 STUN
 *  - 靜態 TURN 配置
 *  - 動態 TURN 憑證取得（Cloud Function）
 *  - 快取機制
 *  - 錯誤處理 fallback
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  IceServerProvider,
  resetIceServerProvider,
  type IceServerProviderConfig,
  type TurnServerConfig,
} from '../../src/core/p2p/IceServerProvider';

describe('IceServerProvider', () => {
  beforeEach(() => {
    resetIceServerProvider();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────
  //  預設配置
  // ────────────────────────────────────────────────────────────────────

  describe('default configuration', () => {
    it('should return Google STUN servers by default', async () => {
      const provider = new IceServerProvider();
      const servers = await provider.getIceServers();

      // 3 STUN + 4 fallback TURN (env vars loaded from .env.local in Vitest)
      expect(servers).toHaveLength(7);
      expect(servers[0]).toEqual({ urls: 'stun:stun.l.google.com:19302' });
      expect(servers[1]).toEqual({ urls: 'stun:stun1.l.google.com:19302' });
      expect(servers[2]).toEqual({ urls: 'stun:stun.relay.metered.ca:80' });
    });

    it('should allow custom STUN URLs', async () => {
      const provider = new IceServerProvider({
        stunUrls: ['stun:custom.stun.example.com:3478'],
      });
      const servers = await provider.getIceServers();

      // 1 custom STUN + 4 fallback TURN (env vars loaded from .env.local)
      expect(servers).toHaveLength(5);
      expect(servers[0]).toEqual({ urls: 'stun:custom.stun.example.com:3478' });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  靜態 TURN 配置
  // ────────────────────────────────────────────────────────────────────

  describe('static TURN configuration', () => {
    it('should include static TURN servers', async () => {
      const provider = new IceServerProvider({
        staticTurn: [
          {
            urls: 'turn:my-turn.example.com:3478',
            username: 'test-user',
            credential: 'test-pass',
          },
        ],
      });

      const servers = await provider.getIceServers();

      // 3 STUN + 1 TURN (has TURN → no fallback)
      expect(servers).toHaveLength(4);

      const turnServer = servers.find(
        (s) => typeof s.urls === 'string' && s.urls.startsWith('turn:')
      );
      expect(turnServer).toBeDefined();
      expect(turnServer!.username).toBe('test-user');
      expect(turnServer!.credential).toBe('test-pass');
    });

    it('should support multiple TURN URLs per config', async () => {
      const provider = new IceServerProvider({
        staticTurn: [
          {
            urls: ['turn:us.turn.example.com:3478', 'turns:us.turn.example.com:443'],
            username: 'user',
            credential: 'pass',
          },
        ],
      });

      const servers = await provider.getIceServers();

      const turnServer = servers.find(
        (s) => Array.isArray(s.urls)
      );
      expect(turnServer).toBeDefined();
      expect(turnServer!.urls).toEqual([
        'turn:us.turn.example.com:3478',
        'turns:us.turn.example.com:443',
      ]);
    });

    it('should support multiple static TURN server entries', async () => {
      const provider = new IceServerProvider({
        staticTurn: [
          { urls: 'turn:us.example.com:3478', username: 'u1', credential: 'p1' },
          { urls: 'turn:eu.example.com:3478', username: 'u2', credential: 'p2' },
        ],
      });

      const servers = await provider.getIceServers();
      // 3 STUN + 2 TURN (has TURN → no fallback)
      expect(servers).toHaveLength(5);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  動態 TURN 配置
  // ────────────────────────────────────────────────────────────────────

  describe('dynamic TURN credentials', () => {
    it('should fetch TURN credentials from endpoint', async () => {
      const mockResponse = {
        iceServers: [
          {
            urls: 'turn:dynamic.example.com:3478',
            username: 'dynamic-user',
            credential: 'dynamic-pass',
          },
        ],
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        })
      );

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn-credentials',
      });

      const servers = await provider.getIceServers();

      // 3 STUN + 1 dynamic TURN (has TURN → no fallback)
      expect(servers).toHaveLength(4);
      const turnServer = servers.find(
        (s) => typeof s.urls === 'string' && s.urls.includes('dynamic')
      );
      expect(turnServer).toBeDefined();
      expect(turnServer!.username).toBe('dynamic-user');

      // 驗證 fetch 被呼叫
      expect(fetch).toHaveBeenCalledWith(
        'https://api.example.com/turn-credentials',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should cache TURN credentials', async () => {
      const mockResponse = {
        iceServers: [
          {
            urls: 'turn:cached.example.com:3478',
            username: 'cached-user',
            credential: 'cached-pass',
          },
        ],
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });
      vi.stubGlobal('fetch', fetchMock);

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
        cacheTtlMs: 60_000, // 1 minute
      });

      // 第一次呼叫
      await provider.getIceServers();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 第二次呼叫：應使用快取
      await provider.getIceServers();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 驗證快取狀態
      const status = provider.getCacheStatus();
      expect(status.cached).toBe(true);
      expect(status.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should invalidate cache when requested', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            iceServers: [
              { urls: 'turn:x.com:3478', username: 'u', credential: 'p' },
            ],
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
      });

      await provider.getIceServers();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      provider.invalidateCache();
      expect(provider.getCacheStatus().cached).toBe(false);

      await provider.getIceServers();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should filter out non-TURN servers from dynamic response', async () => {
      const mockResponse = {
        iceServers: [
          { urls: 'stun:extra.stun.com:3478' }, // should be filtered
          {
            urls: 'turn:real.turn.com:3478',
            username: 'u',
            credential: 'p',
          },
        ],
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        })
      );

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
      });

      const servers = await provider.getIceServers();

      // 2 default STUN + 1 dynamic TURN (stun from response filtered out)
      const turnServers = servers.filter(
        (s) => typeof s.urls === 'string' && s.urls.startsWith('turn:')
      );
      expect(turnServers).toHaveLength(1);
      expect(turnServers[0].urls).toBe('turn:real.turn.com:3478');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  錯誤處理
  // ────────────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should fallback to STUN-only when dynamic TURN fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network error'))
      );

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
      });

      const servers = await provider.getIceServers();

      // 3 STUN + 4 fallback TURN (dynamic failed → fallback TURN activates from env vars)
      expect(servers).toHaveLength(7);
      // First 3 are STUN
      const stunServers = servers.filter((s) => typeof s.urls === 'string' && s.urls.startsWith('stun:'));
      expect(stunServers).toHaveLength(3);
      // Last 4 are fallback TURN
      const turnServers = servers.filter((s) => {
        const url = typeof s.urls === 'string' ? s.urls : '';
        return url.startsWith('turn:') || url.startsWith('turns:');
      });
      expect(turnServers).toHaveLength(4);
    });

    it('should fallback when HTTP response is not ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        })
      );

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
      });

      const servers = await provider.getIceServers();
      // 3 STUN + 4 fallback TURN (dynamic failed, no other TURN → fallback activates)
      expect(servers).toHaveLength(7);
    });

    it('should still include static TURN when dynamic fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('timeout'))
      );

      const provider = new IceServerProvider({
        staticTurn: [
          { urls: 'turn:static.com:3478', username: 'u', credential: 'p' },
        ],
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
      });

      const servers = await provider.getIceServers();
      // 3 STUN + 1 static TURN (dynamic failed, but static TURN exists → no fallback)
      expect(servers).toHaveLength(4);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  並行 fetch dedup
  // ────────────────────────────────────────────────────────────────────

  describe('concurrent fetch deduplication', () => {
    it('should not make multiple concurrent fetch calls', async () => {
      let resolvePromise: (value: Response) => void;
      const pendingPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });

      const fetchMock = vi.fn().mockReturnValue(pendingPromise);
      vi.stubGlobal('fetch', fetchMock);

      const provider = new IceServerProvider({
        useDynamicTurn: true,
        turnCredentialEndpoint: 'https://api.example.com/turn',
      });

      // 同時發起兩個 getIceServers 呼叫
      const p1 = provider.getIceServers();
      const p2 = provider.getIceServers();

      // Resolve the single pending fetch
      resolvePromise!({
        ok: true,
        json: () =>
          Promise.resolve({
            iceServers: [
              { urls: 'turn:x.com:3478', username: 'u', credential: 'p' },
            ],
          }),
      } as Response);

      const [r1, r2] = await Promise.all([p1, p2]);

      // fetch 只被呼叫一次（dedup）
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(r2);
    });
  });
});
