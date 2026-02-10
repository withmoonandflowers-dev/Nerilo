import { describe, it, expect } from 'vitest';
import {
  sha256Hash,
  computePayloadHash,
  computeEntryHash,
  isPlainObject,
  isHex64,
  HASH_HEX_LENGTH,
} from '../../src/utils/crypto';

describe('crypto', () => {
  describe('sha256Hash', () => {
    it('應回傳 64 字元 hex 字串', async () => {
      const h = await sha256Hash('hello');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(h.length).toBe(HASH_HEX_LENGTH);
    });

    it('相同輸入應得到相同 hash', async () => {
      const a = await sha256Hash('test');
      const b = await sha256Hash('test');
      expect(a).toBe(b);
    });

    it('不同輸入應得到不同 hash', async () => {
      const a = await sha256Hash('a');
      const b = await sha256Hash('b');
      expect(a).not.toBe(b);
    });

    it('非字串應拋錯', async () => {
      await expect(sha256Hash(null as unknown as string)).rejects.toThrow(TypeError);
      await expect(sha256Hash(123 as unknown as string)).rejects.toThrow(TypeError);
    });

    it('輸入超過最大長度應拋錯', async () => {
      const long = 'x'.repeat(1_500_000);
      await expect(sha256Hash(long)).rejects.toThrow(RangeError);
    });
  });

  describe('isPlainObject', () => {
    it('純物件應為 true', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    it('null、陣列、基本型別應為 false', () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(1)).toBe(false);
      expect(isPlainObject('x')).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });

    it('Object.create(null) 應為 true', () => {
      expect(isPlainObject(Object.create(null))).toBe(true);
    });
  });

  describe('isHex64', () => {
    it('64 字元 hex 應為 true', () => {
      expect(isHex64('a'.repeat(64).replace(/a/g, '0'))).toBe(true);
      expect(isHex64('0123456789abcdef'.repeat(4))).toBe(true);
    });

    it('非 64 字元或含非 hex 應為 false', () => {
      expect(isHex64('')).toBe(false);
      expect(isHex64('abc')).toBe(false);
      expect(isHex64('g'.repeat(64))).toBe(false);
      expect(isHex64(null)).toBe(false);
      expect(isHex64(64)).toBe(false);
    });
  });

  describe('computePayloadHash', () => {
    it('純物件應得到 64 字元 hex', async () => {
      const h = await computePayloadHash({ type: 'chat', content: 'hi' });
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('相同 payload 應得到相同 hash', async () => {
      const p = { a: 1, b: 2 };
      expect(await computePayloadHash(p)).toBe(await computePayloadHash(p));
    });

    it('非純物件應拋錯', async () => {
      await expect(computePayloadHash(null as unknown as Record<string, unknown>)).rejects.toThrow(TypeError);
      await expect(computePayloadHash([] as unknown as Record<string, unknown>)).rejects.toThrow(TypeError);
    });

    it('序列化後超過 maxSerializedLength 應拋錯', async () => {
      const big = { x: 'a'.repeat(200_000) };
      await expect(computePayloadHash(big, 100_000)).rejects.toThrow(RangeError);
    });
  });

  describe('computeEntryHash', () => {
    const validInput = {
      previousHash: '0',
      index: 0,
      timestamp: 1000,
      payloadHash: 'a'.repeat(64).replace(/a/g, '0'),
      creatorId: 'user1',
    };

    it('合法輸入應得到 64 字元 hex', async () => {
      const h = await computeEntryHash(validInput);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('相同輸入應得到相同 hash', async () => {
      expect(await computeEntryHash(validInput)).toBe(await computeEntryHash(validInput));
    });

    it('index 非非負整數應拋錯', async () => {
      await expect(computeEntryHash({ ...validInput, index: -1 })).rejects.toThrow(TypeError);
      await expect(computeEntryHash({ ...validInput, index: 1.5 })).rejects.toThrow(TypeError);
    });

    it('payloadHash 非 64 字元 hex 應拋錯', async () => {
      await expect(computeEntryHash({ ...validInput, payloadHash: 'abc' })).rejects.toThrow(TypeError);
    });

    it('creatorId 空字串應拋錯', async () => {
      await expect(computeEntryHash({ ...validInput, creatorId: '' })).rejects.toThrow(TypeError);
    });
  });
});
