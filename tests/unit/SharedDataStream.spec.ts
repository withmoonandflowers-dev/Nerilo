import { describe, it, expect } from 'vitest';
import { SharedDataStream } from '../../src/core/mesh/SharedDataStream';
import { computeEntryHash, computePayloadHash } from '../../src/utils/crypto';
import type { LedgerEntry } from '../../src/types';

const ROOM_ID = 'room-1';
const CREATOR_ID = 'user-a';

function createStream(config?: { maxEntries?: number; appendRateLimitPerSecond?: number; maxPayloadSize?: number }) {
  return new SharedDataStream({
    roomId: ROOM_ID,
    creatorId: CREATOR_ID,
    ...config,
  });
}

describe('SharedDataStream', () => {
  describe('append', () => {
    it('應附加一筆條目並回傳 LedgerEntry', async () => {
      const stream = createStream();
      const entry = await stream.append({ type: 'chat', content: 'hello' });
      expect(entry.index).toBe(0);
      expect(entry.creatorId).toBe(CREATOR_ID);
      expect(entry.payload).toEqual({ type: 'chat', content: 'hello' });
      expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.previousHash).toBe('0');
      expect(stream.getEntries().length).toBe(1);
    });

    it('多筆 append 應形成 hash 鏈', async () => {
      const stream = createStream();
      const e0 = await stream.append({ n: 0 });
      const e1 = await stream.append({ n: 1 });
      expect(e1.previousHash).toBe(e0.entryHash);
      expect(e1.index).toBe(1);
      expect(stream.getEntries().length).toBe(2);
    });

    it('payload 非純物件應拋錯', async () => {
      const stream = createStream();
      await expect(stream.append(null as unknown as Record<string, unknown>)).rejects.toThrow(TypeError);
      await expect(stream.append([] as unknown as Record<string, unknown>)).rejects.toThrow(TypeError);
    });

    it('達到 maxEntries 後 append 應拋錯', async () => {
      const stream = createStream({ maxEntries: 2 });
      await stream.append({ a: 1 });
      await stream.append({ a: 2 });
      await expect(stream.append({ a: 3 })).rejects.toThrow(/max entries/);
    });

    it('超過 append 速率應拋錯', async () => {
      const stream = createStream({ appendRateLimitPerSecond: 2 });
      await stream.append({ n: 0 });
      await stream.append({ n: 1 });
      await expect(stream.append({ n: 2 })).rejects.toThrow(/rate limit/);
    });

    it('onEntryAppended 應被呼叫', async () => {
      const stream = createStream();
      const received: LedgerEntry[] = [];
      stream.onEntryAppended((e) => received.push(e));
      await stream.append({ x: 1 });
      await stream.append({ x: 2 });
      expect(received.length).toBe(2);
      expect(received[0]!.payload).toEqual({ x: 1 });
      expect(received[1]!.payload).toEqual({ x: 2 });
    });

    it('setBroadcastHandler 應在 append 時被呼叫', async () => {
      const stream = createStream();
      const broadcasted: LedgerEntry[] = [];
      stream.setBroadcastHandler((e) => broadcasted.push(e));
      await stream.append({ msg: 'hi' });
      expect(broadcasted.length).toBe(1);
      expect(broadcasted[0]!.payload).toEqual({ msg: 'hi' });
    });
  });

  describe('handleReceivedEntry', () => {
    it('合法且銜接的 entry 應被附加', async () => {
      const stream = createStream();
      const e0 = await stream.append({ n: 0 });
      const payload1 = { n: 1 };
      const payloadHash1 = await computePayloadHash(payload1);
      // 固定 timestamp，避免 computeEntryHash 與 entry 物件使用不同毫秒造成 hash 不符
      const ts1 = Date.now();
      const entryHash1 = await computeEntryHash({
        previousHash: e0.entryHash,
        index: 1,
        timestamp: ts1,
        payloadHash: payloadHash1,
        creatorId: 'user-b',
      });
      const entry1: LedgerEntry = {
        index: 1,
        previousHash: e0.entryHash,
        payloadHash: payloadHash1,
        timestamp: ts1,
        creatorId: 'user-b',
        payload: payload1,
        entryHash: entryHash1,
      };
      const ok = await stream.handleReceivedEntry(entry1);
      expect(ok).toBe(true);
      expect(stream.getEntries().length).toBe(2);
      expect(stream.getEntries()[1]!.entryHash).toBe(entryHash1);
    });

    it('重複 entryHash 應拒絕', async () => {
      const stream = createStream();
      const e0 = await stream.append({ n: 0 });
      const payload1 = { n: 1 };
      const payloadHash1 = await computePayloadHash(payload1);
      const ts1 = Date.now();
      const entryHash1 = await computeEntryHash({
        previousHash: e0.entryHash,
        index: 1,
        timestamp: ts1,
        payloadHash: payloadHash1,
        creatorId: 'user-b',
      });
      const entry1: LedgerEntry = {
        index: 1,
        previousHash: e0.entryHash,
        payloadHash: payloadHash1,
        timestamp: ts1,
        creatorId: 'user-b',
        payload: payload1,
        entryHash: entryHash1,
      };
      await stream.handleReceivedEntry(entry1);
      const ok2 = await stream.handleReceivedEntry(entry1);
      expect(ok2).toBe(false);
      expect(stream.getEntries().length).toBe(2);
    });

    it('previousHash 與本地最後一筆不符應拒絕', async () => {
      const stream = createStream();
      await stream.append({ n: 0 });
      const badEntry: LedgerEntry = {
        index: 1,
        previousHash: 'wrong_previous_hash_value_32chars_xxxxxxxxxx',
        payloadHash: 'a'.repeat(64).replace(/a/g, '0'),
        timestamp: Date.now(),
        creatorId: 'user-b',
        payload: { n: 1 },
        entryHash: 'b'.repeat(64).replace(/b/g, '1'),
      };
      const ok = await stream.handleReceivedEntry(badEntry);
      expect(ok).toBe(false);
      expect(stream.getEntries().length).toBe(1);
    });

    it('index 不連續應拒絕', async () => {
      const stream = createStream();
      const e0 = await stream.append({ n: 0 });
      const payloadHash1 = await computePayloadHash({ n: 1 });
      const entryHash1 = await computeEntryHash({
        previousHash: e0.entryHash,
        index: 2, // 錯誤：應為 1
        timestamp: Date.now(),
        payloadHash: payloadHash1,
        creatorId: 'user-b',
      });
      const entry: LedgerEntry = {
        index: 2,
        previousHash: e0.entryHash,
        payloadHash: payloadHash1,
        timestamp: Date.now(),
        creatorId: 'user-b',
        payload: { n: 1 },
        entryHash: entryHash1,
      };
      const ok = await stream.handleReceivedEntry(entry);
      expect(ok).toBe(false);
      expect(stream.getEntries().length).toBe(1);
    });

    it('entry 結構不合法應拒絕', async () => {
      const stream = createStream();
      const bad = {
        index: 0,
        previousHash: '0',
        payloadHash: '0'.repeat(64),
        timestamp: Date.now(),
        creatorId: CREATOR_ID,
        payload: { x: 1 },
        entryHash: '0'.repeat(64),
      };
      await expect(stream.handleReceivedEntry({ ...bad, index: -1 } as LedgerEntry)).resolves.toBe(false);
      await expect(stream.handleReceivedEntry({ ...bad, creatorId: '' } as LedgerEntry)).resolves.toBe(false);
      await expect(stream.handleReceivedEntry({ ...bad, payload: null } as unknown as LedgerEntry)).resolves.toBe(false);
    });
  });

  describe('resetFromEntries', () => {
    it('合法完整鏈應取代本地 entries', async () => {
      const stream = createStream();
      const e0 = await stream.append({ n: 0 });
      const e1Payload = { n: 1 };
      const payloadHash1 = await computePayloadHash(e1Payload);
      const entryHash1 = await computeEntryHash({
        previousHash: e0.entryHash,
        index: 1,
        timestamp: e0.timestamp + 1,
        payloadHash: payloadHash1,
        creatorId: 'user-b',
      });
      const remoteEntries: LedgerEntry[] = [
        e0,
        {
          index: 1,
          previousHash: e0.entryHash,
          payloadHash: payloadHash1,
          timestamp: e0.timestamp + 1,
          creatorId: 'user-b',
          payload: e1Payload,
          entryHash: entryHash1,
        },
      ];
      const ok = await stream.resetFromEntries(remoteEntries);
      expect(ok).toBe(true);
      expect(stream.getEntries().length).toBe(2);
    });

    it('空陣列應回傳 false', async () => {
      const stream = createStream();
      expect(await stream.resetFromEntries([])).toBe(false);
    });

    it('鏈中 hash 不符應回傳 false', async () => {
      const stream = createStream();
      const e0 = await stream.append({ n: 0 });
      const badChain: LedgerEntry[] = [
        e0,
        {
          index: 1,
          previousHash: 'wrong',
          payloadHash: await computePayloadHash({ n: 1 }),
          timestamp: Date.now(),
          creatorId: 'user-b',
          payload: { n: 1 },
          entryHash: 'f'.repeat(64),
        } as LedgerEntry,
      ];
      expect(await stream.resetFromEntries(badChain)).toBe(false);
    });
  });

  describe('getEntries / getLastEntry', () => {
    it('初始時 getEntries 為空、getLastEntry 為 null', () => {
      const stream = createStream();
      expect(stream.getEntries().length).toBe(0);
      expect(stream.getLastEntry()).toBe(null);
    });

    it('append 後 getLastEntry 為最後一筆', async () => {
      const stream = createStream();
      const e0 = await stream.append({ a: 0 });
      expect(stream.getLastEntry()).toEqual(e0);
      const e1 = await stream.append({ a: 1 });
      expect(stream.getLastEntry()).toEqual(e1);
    });
  });
});
