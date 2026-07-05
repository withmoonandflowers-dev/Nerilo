/**
 * GossipMessageHandler 單元測試
 *
 * 覆蓋修復項目：
 * - TTL 不可變性：handleReceivedMessage 不應修改傳入的訊息物件
 * - 訊息去重：(senderId, seq) 為訊息身分，重複遞送（含並行）只通知一次
 * - 亂序容忍：未見過的較早 seq 必須接受（anti-entropy 補送依賴此行為）
 * - anti-entropy 對帳：digest 交換 → 補送對方缺的訊息
 * - 發送速率限制：超過 10 msg/s 應拋錯
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GossipMessageHandler } from '../../src/core/mesh/GossipMessageHandler';
import { SecurityManager } from '../../src/core/mesh/SecurityManager';
import { arrayBufferToBase64 } from '../../src/utils/crypto';
import type { GossipMessage } from '../../src/types';

// ── Mock MeshTopologyManager ────────────────────────────────────────────────

function makeMockNeighbor(id: string) {
  return {
    getId: vi.fn().mockReturnValue(id),
    getState: vi.fn().mockReturnValue('connected'),
    send: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onDigest: vi.fn(),
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

    it('TTL 為 0 時仍顯示但不轉發（ttl 只限制洪泛半徑，不限制呈現）', async () => {
      const message = makeMessage({ ttl: 0, seq: 1 });
      const listener = vi.fn();
      handler.onMessage(listener);

      const neighbors = topology.getNeighbors();
      await handler.handleReceivedMessage(message, 'neighbor-1');

      // anti-entropy 補送可能以 ttl=0 到達：對使用者仍須恰好一次呈現
      expect(listener).toHaveBeenCalledTimes(1);
      // 但不再轉發
      for (const n of neighbors) {
        expect(n.send).not.toHaveBeenCalled();
      }
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

    it('亂序到達的較早 seq（未見過）應被接受 — anti-entropy 補送場景', async () => {
      const listener = vi.fn();
      handler.onMessage(listener);

      // 先收到 seq=5（例如經轉發先到）
      await handler.handleReceivedMessage(makeMessage({ seq: 5, content: 'later' }), 'n1');
      // 再收到 seq=3（對帳補送回來的較早訊息）——舊實作在此誤判為重放而永久遺失
      await handler.handleReceivedMessage(makeMessage({ seq: 3, content: 'earlier' }), 'n1');

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('同一 (senderId, seq) 並行遞送只 notify 一次（inflight 預佔）', async () => {
      const listener = vi.fn();
      handler.onMessage(listener);

      // 兩個鄰居「同時」遞同一則：不 await 第一個就開始第二個
      const m = makeMessage({ seq: 7 });
      await Promise.all([
        handler.handleReceivedMessage(m, 'n1'),
        handler.handleReceivedMessage({ ...m }, 'n2'),
      ]);

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
    it('驗簽以 maxAgeMs: null 呼叫（回歸：時效窗拒掉 anti-entropy 補送的舊訊息）', async () => {
      // 時效防護在 gossip 路徑由 (senderId, seq) 去重承擔；驗簽若帶預設
      // 5 分鐘窗，補送給遲到者的舊訊息會被拒、永久遺失。
      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');

      expect(security.verifyMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { maxAgeMs: null },
      );
    });

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

  // ── anti-entropy 對帳 ─────────────────────────────────────────────────────

  describe('anti-entropy（digest 對帳）', () => {
    it('sendDigestTo：store 為空時不送 digest', async () => {
      const neighbor = makeMockNeighbor('n1');
      await handler.sendDigestTo(neighbor as any);
      expect(neighbor.sendDigest).not.toHaveBeenCalled();
    });

    it('sendDigestTo：收過訊息後送出含該 sender 持有摘要的 digest', async () => {
      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');
      await handler.handleReceivedMessage(makeMessage({ seq: 3, content: 'c3' }), 'n1');

      const neighbor = makeMockNeighbor('n1');
      await handler.sendDigestTo(neighbor as any);

      expect(neighbor.sendDigest).toHaveBeenCalledTimes(1);
      const digest = neighbor.sendDigest.mock.calls[0][0];
      expect(digest['sender-abc']).toEqual({ floor: 1, max: 3, missing: [2] });
    });

    it('handleDigest：把對方缺的訊息補送過去（對方沒聽過該 sender → 全補）', async () => {
      await handler.handleReceivedMessage(makeMessage({ seq: 1, content: 'm1' }), 'n1');
      await handler.handleReceivedMessage(makeMessage({ seq: 2, content: 'm2' }), 'n1');

      const neighbor = makeMockNeighbor('n2');
      await handler.handleDigest({}, neighbor as any);

      const sentSeqs = neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
      expect(sentSeqs).toEqual([1, 2]);
    });

    it('handleDigest：只補對方 missing/max 之外的，已持有的不重送', async () => {
      await handler.handleReceivedMessage(makeMessage({ seq: 1, content: 'm1' }), 'n1');
      await handler.handleReceivedMessage(makeMessage({ seq: 2, content: 'm2' }), 'n1');
      await handler.handleReceivedMessage(makeMessage({ seq: 3, content: 'm3' }), 'n1');

      const neighbor = makeMockNeighbor('n2');
      // 對方宣告：有 1..3 但缺 2
      await handler.handleDigest(
        { 'sender-abc': { floor: 1, max: 3, missing: [2] } },
        neighbor as any,
      );

      const sentSeqs = neighbor.send.mock.calls.map((c) => (c[0] as GossipMessage).seq);
      expect(sentSeqs).toEqual([2]);
    });

    it('handleDigest：畸形 digest 直接忽略、不拋錯不補送', async () => {
      await handler.handleReceivedMessage(makeMessage({ seq: 1 }), 'n1');
      const neighbor = makeMockNeighbor('n2');

      await handler.handleDigest('garbage', neighbor as any);
      await handler.handleDigest({ 'sender-abc': { floor: -1, max: 'x', missing: null } }, neighbor as any);

      expect(neighbor.send).not.toHaveBeenCalled();
    });

    it('自己送出的訊息也進 store，會被 digest 對帳補給缺的 peer', async () => {
      await handler.sendMessage('from-local');

      const neighbor = makeMockNeighbor('n2');
      await handler.handleDigest({}, neighbor as any);

      const sent = neighbor.send.mock.calls.map((c) => c[0] as GossipMessage);
      expect(sent).toHaveLength(1);
      expect(sent[0].senderId).toBe('local-user');
      expect(sent[0].content).toBe('from-local');
    });
  });

  // ── 補送舊訊息（真 SecurityManager 整合）──────────────────────────────────

  describe('anti-entropy 補送 >5 分鐘舊訊息（真 SecurityManager 整合）', () => {
    it('遲到者收到 30 分鐘前簽名的補送訊息：恰好一次呈現，重複補送被去重', async () => {
      const realSecurity = new SecurityManager();
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const pubKeyB64 = arrayBufferToBase64(
        await crypto.subtle.exportKey('spki', kp.publicKey),
      );

      // 補送到達時可能 ttl=0（原始洪泛已耗盡半徑）——顯示不受 ttl 限制
      const unsigned: Omit<GossipMessage, 'signature'> = {
        roomId: 'room-test',
        senderId: 'sender-abc',
        pubKey: pubKeyB64,
        seq: 1,
        timestamp: Date.now() - 30 * 60 * 1000,
        content: 'old-but-valid',
        ttl: 0,
      };
      const signature = await realSecurity.signMessage(unsigned, kp.privateKey);
      const fillMessage: GossipMessage = { ...unsigned, signature };

      const lateJoiner = new GossipMessageHandler(
        'room-test',
        'late-user',
        identity as any, // deriveUserId mock 回傳 'sender-abc'，與訊息一致
        realSecurity,
        topology as any,
      );
      const listener = vi.fn();
      lateJoiner.onMessage(listener);

      await lateJoiner.handleReceivedMessage(fillMessage, 'n1');
      expect(listener).toHaveBeenCalledTimes(1);

      // 另一鄰居的 digest 輪再補一次同一則 → (senderId, seq) 去重擋下
      await lateJoiner.handleReceivedMessage({ ...fillMessage }, 'n2');
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
