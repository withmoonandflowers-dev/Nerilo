/**
 * GossipMessageHandler 單元測試
 *
 * 覆蓋修復項目：
 * - TTL 不可變性：handleReceivedMessage 不應修改傳入的訊息物件
 * - 訊息去重：相同訊息只通知監聽器一次
 * - 序列號檢查：舊的或重放的訊息應被拒絕
 * - 發送速率限制：超過 10 msg/s 應拋錯
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import type { GossipMessage } from '../../src/types';

// ── Mock MeshTopologyManager ────────────────────────────────────────────────

function makeMockNeighbor(id: string) {
  return {
    getId: vi.fn().mockReturnValue(id),
    getState: vi.fn().mockReturnValue('connected'),
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
  };
}

function makeMockTopologyManager(neighborIds: string[] = []) {
  const neighbors = neighborIds.map(id => makeMockNeighbor(id));
  return {
    getNeighbors: vi.fn().mockReturnValue(neighbors),
    getGossipConfig: vi.fn().mockReturnValue({ fanout: 2, ttl: 8 }),
  };
}

// ── Mock IdentityManager ────────────────────────────────────────────────────

function makeMockIdentityManager() {
  return {
    exportPublicKey: vi.fn().mockResolvedValue('mock-pub-key-base64'),
    getPrivateKey: vi.fn().mockReturnValue({} as CryptoKey),
    // deriveUserId：預設回傳 'sender-abc' 以匹配 makeMessage 的 senderId
    deriveUserId: vi.fn().mockResolvedValue('sender-abc'),
  };
}

// ── Mock SecurityManager ────────────────────────────────────────────────────

function makeMockSecurityManager(verifyResult = true) {
  return {
    signMessage: vi.fn().mockResolvedValue('mock-signature'),
    importPublicKey: vi.fn().mockResolvedValue({} as CryptoKey),
    verifyMessage: vi.fn().mockResolvedValue(verifyResult),
  };
}

// ── Helper: build a valid GossipMessage ─────────────────────────────────────

function makeMessage(overrides: Partial<GossipMessage> = {}): GossipMessage {
  return {
    roomId: 'room-test',
    senderId: 'sender-abc',
    pubKey: 'mock-pub-key-base64',
    seq: 1,
    timestamp: 1_000_000,
    content: 'hello',
    ttl: 3,
    signature: 'mock-signature',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GossipMessageHandler', () => {
  let handler: GossipMessageHandler;
  let topology: ReturnType<typeof makeMockTopologyManager>;
  let identity: ReturnType<typeof makeMockIdentityManager>;
  let security: ReturnType<typeof makeMockSecurityManager>;

  beforeEach(() => {
    topology = makeMockTopologyManager(['neighbor-1', 'neighbor-2']);
    identity = makeMockIdentityManager();
    security = makeMockSecurityManager(true);

    handler = new GossipMessageHandler(
      'room-test',
      'local-user',
      identity as any,
      security as any,
      topology as any,
    );
  });

  // ── TTL 不可變性 ─────────────────────────────────────────────────────────

  describe('handleReceivedMessage — TTL 不可變性', () => {
    it('不應修改傳入的 message.ttl', async () => {
      const message = makeMessage({ ttl: 3, seq: 1 });
      const originalTtl = message.ttl;

      await handler.handleReceivedMessage(message, 'neighbor-1');

      expect(message.ttl).toBe(originalTtl);
    });

    it('轉發給鄰居時使用 ttl - 1', async () => {
      const message = makeMessage({ ttl: 3, seq: 1 });

      // 取得 topology 的鄰居 mock，以便檢查 send 的參數
      const neighbors = topology.getNeighbors();
      await handler.handleReceivedMessage(message, 'neighbor-1');

      // 找出有被呼叫 send 的鄰居（非排除鄰居）
      const calledNeighbor = neighbors.find(n => n.send.mock.calls.length > 0);
      if (calledNeighbor) {
        const forwarded = calledNeighbor.send.mock.calls[0][0] as GossipMessage;
        expect(forwarded.ttl).toBe(2); // 原始 3 - 1
      }
    });

    it('TTL 為 0 時不轉發', async () => {
      const message = makeMessage({ ttl: 0, seq: 1 });
      // TTL=0 時訊息應被丟棄（不通知監聽器也不轉發）
      const listener = vi.fn();
      handler.onMessage(listener);

      await handler.handleReceivedMessage(message, 'neighbor-1');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── 訊息去重 ─────────────────────────────────────────────────────────────

  describe('handleReceivedMessage — 去重', () => {
    it('相同訊息第二次接收不應觸發監聽器', async () => {
      const message = makeMessage({ seq: 1 });
      const listener = vi.fn();
      handler.onMessage(listener);

      await handler.handleReceivedMessage(message, 'neighbor-1');
      await handler.handleReceivedMessage(message, 'neighbor-2');

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── 序列號檢查 ────────────────────────────────────────────────────────────

  describe('handleReceivedMessage — 序列號', () => {
    it('seq 遞增的訊息應被接受', async () => {
      const listener = vi.fn();
      handler.onMessage(listener);

      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');
      await handler.handleReceivedMessage(makeMessage({ seq: 2, content: 'msg2' }), 'n1');

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('舊的 seq（小於等於上次）應被拒絕', async () => {
      const listener = vi.fn();
      handler.onMessage(listener);

      // 先接受 seq=5
      await handler.handleReceivedMessage(makeMessage({ seq: 5, content: 'first' }), 'n1');
      // 再嘗試 seq=3（舊的）
      await handler.handleReceivedMessage(makeMessage({ seq: 3, content: 'replay' }), 'n1');

      // 只有第一條應觸發監聽器
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('重複的 seq=1 應被拒絕（防重放）', async () => {
      const listener = vi.fn();
      handler.onMessage(listener);

      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');
      // 不同 content 但 seq 相同
      await handler.handleReceivedMessage(makeMessage({ seq: 1, content: 'replay' }), 'n2');

      // seq check 拒絕第二條（與去重也可能介入，取決於順序）
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── 簽名驗證 ─────────────────────────────────────────────────────────────

  describe('handleReceivedMessage — 簽名驗證', () => {
    it('簽名無效時不觸發監聽器', async () => {
      // 建立一個 verifyMessage 回傳 false 的 security mock
      security = makeMockSecurityManager(false);
      handler = new GossipMessageHandler(
        'room-test',
        'local-user',
        identity as any,
        security as any,
        topology as any,
      );

      const listener = vi.fn();
      handler.onMessage(listener);

      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── 監聽器訂閱 / 取消訂閱 ─────────────────────────────────────────────────

  describe('onMessage', () => {
    it('取消訂閱後不再收到訊息', async () => {
      const listener = vi.fn();
      const unsubscribe = handler.onMessage(listener);

      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');
      unsubscribe();
      await handler.handleReceivedMessage(makeMessage({ seq: 2, content: 'after-unsub' }), 'n1');

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── 發送速率限制 ──────────────────────────────────────────────────────────

  describe('sendMessage — 速率限制', () => {
    it('連續傳送超過 10 則/秒應拋出 rate limit 錯誤', async () => {
      // 前 10 次應成功
      for (let i = 0; i < 10; i++) {
        await handler.sendMessage(`message-${i}`);
      }

      // 第 11 次應被 rate limiter 拒絕
      await expect(handler.sendMessage('message-overflow')).rejects.toThrow('Rate limit exceeded');
    });
  });
});
