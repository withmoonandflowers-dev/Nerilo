import { describe, it, expect } from 'vitest';
import {
  padMessage,
  unpadMessage,
  padString,
  unpadString,
  getPaddedSize,
  getBlockSize,
} from '../../src/core/relay/MessagePadding';

describe('MessagePadding', () => {
  describe('padMessage / unpadMessage', () => {
    it('pads and unpads a small message', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5]);
      const padded = padMessage(original);

      expect(padded.length).toBe(256); // Minimum block size
      expect(padded.length % getBlockSize()).toBe(0);

      const unpadded = unpadMessage(padded);
      expect(unpadded).toEqual(original);
    });

    it('pads to next block boundary', () => {
      // 256 - 4 (length prefix) = 252 bytes fit in first block
      const fits = new Uint8Array(252);
      expect(padMessage(fits).length).toBe(256);

      // 253 bytes needs next block
      const overflow = new Uint8Array(253);
      expect(padMessage(overflow).length).toBe(512);
    });

    it('preserves empty message', () => {
      const empty = new Uint8Array(0);
      const padded = padMessage(empty);
      expect(padded.length).toBe(256);
      const unpadded = unpadMessage(padded);
      expect(unpadded.length).toBe(0);
    });

    it('preserves large message', () => {
      const large = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) large[i] = i % 256;
      const padded = padMessage(large);
      expect(padded.length % getBlockSize()).toBe(0);
      const unpadded = unpadMessage(padded);
      expect(unpadded).toEqual(large);
    });

    it('throws on oversized message', () => {
      const tooBig = new Uint8Array(65536);
      expect(() => padMessage(tooBig)).toThrow();
    });
  });

  describe('padString / unpadString', () => {
    it('pads and unpads a string', () => {
      const msg = '你好世界 Hello World 🌍';
      const padded = padString(msg);
      expect(padded.length % getBlockSize()).toBe(0);
      expect(unpadString(padded)).toBe(msg);
    });

    it('handles empty string', () => {
      expect(unpadString(padString(''))).toBe('');
    });
  });

  describe('getPaddedSize', () => {
    it('returns correct padded size', () => {
      expect(getPaddedSize(0)).toBe(256);
      expect(getPaddedSize(100)).toBe(256);
      expect(getPaddedSize(252)).toBe(256);
      expect(getPaddedSize(253)).toBe(512);
    });
  });

  describe('error handling', () => {
    it('throws on too-short padded message', () => {
      expect(() => unpadMessage(new Uint8Array(2))).toThrow();
    });

    it('throws on invalid length prefix', () => {
      const bad = new Uint8Array(256);
      const view = new DataView(bad.buffer);
      view.setUint32(0, 9999, false); // Invalid length
      expect(() => unpadMessage(bad)).toThrow();
    });
  });
});
