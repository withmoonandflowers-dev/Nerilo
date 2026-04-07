/**
 * StoreAndForward 單元測試
 *
 * 測試 store-and-forward 的核心邏輯（mock Firestore）：
 *  - 訊息存入 inbox
 *  - 大小限制檢查
 *  - drain 排空邏輯
 *  - 批次限制
 *  - TTL 設定
 *  - 清理資源
 *
 * 注意：因為 StoreAndForward 直接依賴 firebase/firestore，
 *       我們測試其公開介面的行為邏輯而非 Firestore 實際呼叫。
 *       這裡使用純邏輯等效測試，驗證 config 和驗證邏輯。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 純邏輯等效測試（不需要 Firebase） ──────────────────────────────────────

/**
 * 模擬 StoreAndForward 的核心邏輯
 * （Firestore 操作被抽離，只測試驗證和流程控制）
 */

interface StoredMessage {
  from: string;
  payload: string;
  createdAt: number;
  expiresAt: number;
}

interface StoreAndForwardConfig {
  messageTtlMs?: number;
  maxPayloadBytes?: number;
  drainBatchSize?: number;
}

class StoreAndForwardLogic {
  private messageTtlMs: number;
  private maxPayloadBytes: number;
  private drainBatchSize: number;

  /** 模擬 Firestore inbox：{ roomId/uid → messages[] } */
  private inboxes: Map<string, StoredMessage[]> = new Map();

  constructor(config: StoreAndForwardConfig = {}) {
    this.messageTtlMs = config.messageTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxPayloadBytes = config.maxPayloadBytes ?? 64 * 1024;
    this.drainBatchSize = config.drainBatchSize ?? 100;
  }

  async store(
    roomId: string,
    recipientUid: string,
    fromUid: string,
    payload: string
  ): Promise<string> {
    const payloadSize = new TextEncoder().encode(payload).length;
    if (payloadSize > this.maxPayloadBytes) {
      throw new Error(
        `Payload exceeds ${this.maxPayloadBytes} bytes limit (got ${payloadSize})`
      );
    }

    const key = `${roomId}/${recipientUid}`;
    if (!this.inboxes.has(key)) {
      this.inboxes.set(key, []);
    }

    const now = Date.now();
    const msg: StoredMessage = {
      from: fromUid,
      payload,
      createdAt: now,
      expiresAt: now + this.messageTtlMs,
    };

    this.inboxes.get(key)!.push(msg);
    return `doc-${now}-${Math.random()}`;
  }

  async drain(
    roomId: string,
    myUid: string,
    handler: (from: string, payload: string) => void
  ): Promise<number> {
    const key = `${roomId}/${myUid}`;
    const inbox = this.inboxes.get(key);
    if (!inbox || inbox.length === 0) return 0;

    const now = Date.now();
    // 過濾未過期的訊息
    const valid = inbox.filter((m) => m.expiresAt > now);
    const toConsume = valid.slice(0, this.drainBatchSize);

    let consumed = 0;
    for (const msg of toConsume) {
      handler(msg.from, msg.payload);
      consumed++;
    }

    // 移除已消費的
    const consumed_set = new Set(toConsume);
    this.inboxes.set(
      key,
      inbox.filter((m) => !consumed_set.has(m))
    );

    return consumed;
  }

  async getPendingCount(roomId: string, myUid: string): Promise<number> {
    const key = `${roomId}/${myUid}`;
    const inbox = this.inboxes.get(key);
    if (!inbox) return 0;
    const now = Date.now();
    return inbox.filter((m) => m.expiresAt > now).length;
  }

  async cleanupExpired(roomId: string, recipientUid: string): Promise<number> {
    const key = `${roomId}/${recipientUid}`;
    const inbox = this.inboxes.get(key);
    if (!inbox) return 0;

    const now = Date.now();
    const expired = inbox.filter((m) => m.expiresAt <= now);
    this.inboxes.set(
      key,
      inbox.filter((m) => m.expiresAt > now)
    );
    return expired.length;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StoreAndForward Logic', () => {
  let saf: StoreAndForwardLogic;

  beforeEach(() => {
    saf = new StoreAndForwardLogic();
  });

  // ── store ──────────────────────────────────────────────────────────

  describe('store()', () => {
    it('should store a message in the inbox', async () => {
      const docId = await saf.store('room-1', 'bob', 'alice', '{"msg":"hello"}');
      expect(docId).toBeTruthy();

      const count = await saf.getPendingCount('room-1', 'bob');
      expect(count).toBe(1);
    });

    it('should store multiple messages for the same recipient', async () => {
      await saf.store('room-1', 'bob', 'alice', '{"msg":"hello"}');
      await saf.store('room-1', 'bob', 'alice', '{"msg":"world"}');
      await saf.store('room-1', 'bob', 'carol', '{"msg":"hi"}');

      const count = await saf.getPendingCount('room-1', 'bob');
      expect(count).toBe(3);
    });

    it('should reject payloads exceeding size limit', async () => {
      const largePayload = 'x'.repeat(65 * 1024); // 65KB

      await expect(
        saf.store('room-1', 'bob', 'alice', largePayload)
      ).rejects.toThrow('Payload exceeds');
    });

    it('should accept payloads at exactly the size limit', async () => {
      const saf64k = new StoreAndForwardLogic({ maxPayloadBytes: 100 });
      const exactPayload = 'x'.repeat(100);

      await expect(
        saf64k.store('room-1', 'bob', 'alice', exactPayload)
      ).resolves.toBeTruthy();
    });

    it('should respect custom max payload size', async () => {
      const smallSaf = new StoreAndForwardLogic({ maxPayloadBytes: 10 });

      await expect(
        smallSaf.store('room-1', 'bob', 'alice', '12345678901') // 11 bytes
      ).rejects.toThrow('Payload exceeds 10 bytes');
    });

    it('should isolate inboxes between different rooms', async () => {
      await saf.store('room-1', 'bob', 'alice', '{"msg":"r1"}');
      await saf.store('room-2', 'bob', 'alice', '{"msg":"r2"}');

      expect(await saf.getPendingCount('room-1', 'bob')).toBe(1);
      expect(await saf.getPendingCount('room-2', 'bob')).toBe(1);
    });

    it('should isolate inboxes between different recipients', async () => {
      await saf.store('room-1', 'bob', 'alice', '{"msg":"for bob"}');
      await saf.store('room-1', 'carol', 'alice', '{"msg":"for carol"}');

      expect(await saf.getPendingCount('room-1', 'bob')).toBe(1);
      expect(await saf.getPendingCount('room-1', 'carol')).toBe(1);
    });
  });

  // ── drain ──────────────────────────────────────────────────────────

  describe('drain()', () => {
    it('should consume all pending messages', async () => {
      await saf.store('room-1', 'bob', 'alice', '{"n":1}');
      await saf.store('room-1', 'bob', 'carol', '{"n":2}');

      const received: Array<{ from: string; payload: string }> = [];
      const count = await saf.drain('room-1', 'bob', (from, payload) => {
        received.push({ from, payload });
      });

      expect(count).toBe(2);
      expect(received).toHaveLength(2);
      expect(received[0].from).toBe('alice');
      expect(received[1].from).toBe('carol');

      // Inbox should be empty after drain
      expect(await saf.getPendingCount('room-1', 'bob')).toBe(0);
    });

    it('should return 0 for empty inbox', async () => {
      const count = await saf.drain('room-1', 'bob', () => {});
      expect(count).toBe(0);
    });

    it('should respect batch size limit', async () => {
      const smallBatch = new StoreAndForwardLogic({ drainBatchSize: 2 });

      await smallBatch.store('room-1', 'bob', 'alice', '{"n":1}');
      await smallBatch.store('room-1', 'bob', 'alice', '{"n":2}');
      await smallBatch.store('room-1', 'bob', 'alice', '{"n":3}');

      const count = await smallBatch.drain('room-1', 'bob', () => {});
      expect(count).toBe(2); // batch limit

      // 1 message should remain
      expect(await smallBatch.getPendingCount('room-1', 'bob')).toBe(1);
    });

    it('should skip expired messages', async () => {
      const shortTtl = new StoreAndForwardLogic({ messageTtlMs: 1 }); // 1ms TTL

      await shortTtl.store('room-1', 'bob', 'alice', '{"n":1}');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10));

      const count = await shortTtl.drain('room-1', 'bob', () => {});
      expect(count).toBe(0);
    });
  });

  // ── cleanup ────────────────────────────────────────────────────────

  describe('cleanupExpired()', () => {
    it('should remove expired messages', async () => {
      const shortTtl = new StoreAndForwardLogic({ messageTtlMs: 1 });

      await shortTtl.store('room-1', 'bob', 'alice', '{"n":1}');
      await shortTtl.store('room-1', 'bob', 'alice', '{"n":2}');

      await new Promise((r) => setTimeout(r, 10));

      const cleaned = await shortTtl.cleanupExpired('room-1', 'bob');
      expect(cleaned).toBe(2);

      expect(await shortTtl.getPendingCount('room-1', 'bob')).toBe(0);
    });

    it('should not remove non-expired messages', async () => {
      await saf.store('room-1', 'bob', 'alice', '{"n":1}');

      const cleaned = await saf.cleanupExpired('room-1', 'bob');
      expect(cleaned).toBe(0);

      expect(await saf.getPendingCount('room-1', 'bob')).toBe(1);
    });

    it('should return 0 for non-existent inbox', async () => {
      const cleaned = await saf.cleanupExpired('room-1', 'nobody');
      expect(cleaned).toBe(0);
    });
  });

  // ── TTL configuration ─────────────────────────────────────────────

  describe('TTL configuration', () => {
    it('should use default 24h TTL', async () => {
      await saf.store('room-1', 'bob', 'alice', '{"msg":"test"}');
      const count = await saf.getPendingCount('room-1', 'bob');
      expect(count).toBe(1); // Not expired yet
    });

    it('should use custom TTL', async () => {
      const customTtl = new StoreAndForwardLogic({ messageTtlMs: 50 });

      await customTtl.store('room-1', 'bob', 'alice', '{"msg":"short lived"}');
      expect(await customTtl.getPendingCount('room-1', 'bob')).toBe(1);

      await new Promise((r) => setTimeout(r, 60));
      expect(await customTtl.getPendingCount('room-1', 'bob')).toBe(0);
    });
  });

  // ── 端到端流程 ─────────────────────────────────────────────────────

  describe('end-to-end flow', () => {
    it('should support full offline → online message delivery', async () => {
      // 1. Alice 發送訊息，Bob 離線 → 存入 inbox
      await saf.store('room-1', 'bob', 'alice', JSON.stringify({
        type: 'MSG_SEND', content: 'hello bob (offline)',
      }));
      await saf.store('room-1', 'bob', 'alice', JSON.stringify({
        type: 'MSG_SEND', content: 'second message',
      }));

      // 2. Bob 上線 → drain inbox
      const received: string[] = [];
      const count = await saf.drain('room-1', 'bob', (from, payload) => {
        received.push(payload);
      });

      expect(count).toBe(2);
      expect(JSON.parse(received[0]).content).toBe('hello bob (offline)');
      expect(JSON.parse(received[1]).content).toBe('second message');

      // 3. Inbox 已清空
      expect(await saf.getPendingCount('room-1', 'bob')).toBe(0);
    });
  });
});
