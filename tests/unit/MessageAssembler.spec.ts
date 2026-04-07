import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageAssembler } from '../../src/core/relay/MessageAssembler';

describe('MessageAssembler', () => {
  let assembler: MessageAssembler;

  beforeEach(() => {
    assembler = new MessageAssembler();
  });

  afterEach(() => {
    assembler.destroy();
  });

  describe('message deduplication', () => {
    it('accepts first arrival', () => {
      const payload = new Uint8Array([1, 2, 3]);
      const result = assembler.processMessage('msg-1', payload, 'path-a');
      expect(result).toBe(true);
    });

    it('rejects duplicate messages', () => {
      const payload = new Uint8Array([1, 2, 3]);
      assembler.processMessage('msg-1', payload, 'path-a');
      const result = assembler.processMessage('msg-1', payload, 'path-b');
      expect(result).toBe(false);
    });

    it('accepts different message IDs', () => {
      const payload = new Uint8Array([1, 2, 3]);
      expect(assembler.processMessage('msg-1', payload, 'path-a')).toBe(true);
      expect(assembler.processMessage('msg-2', payload, 'path-a')).toBe(true);
    });

    it('tracks seen count', () => {
      assembler.processMessage('msg-1', new Uint8Array([1]), 'path-a');
      assembler.processMessage('msg-2', new Uint8Array([2]), 'path-b');
      expect(assembler.getSeenCount()).toBe(2);
    });
  });

  describe('message delivery', () => {
    it('delivers first arrival to handler', () => {
      const handler = vi.fn();
      assembler.onMessage(handler);

      const payload = new Uint8Array([1, 2, 3]);
      assembler.processMessage('msg-1', payload, 'path-a');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('msg-1', payload, 'path-a');
    });

    it('does not deliver duplicates', () => {
      const handler = vi.fn();
      assembler.onMessage(handler);

      const payload = new Uint8Array([1, 2, 3]);
      assembler.processMessage('msg-1', payload, 'path-a');
      assembler.processMessage('msg-1', payload, 'path-b');

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('path feedback', () => {
    it('emits first arrival feedback', () => {
      const feedback = vi.fn();
      assembler.onPathFeedback(feedback);

      assembler.processMessage('msg-1', new Uint8Array([1]), 'path-a');

      expect(feedback).toHaveBeenCalledWith('msg-1', 'path-a', true, 0);
    });

    it('emits non-first-arrival feedback for duplicates', () => {
      const feedback = vi.fn();
      assembler.onPathFeedback(feedback);

      assembler.processMessage('msg-1', new Uint8Array([1]), 'path-a');
      assembler.processMessage('msg-1', new Uint8Array([1]), 'path-b');

      expect(feedback).toHaveBeenCalledTimes(2);
      const secondCall = feedback.mock.calls[1];
      expect(secondCall[1]).toBe('path-b');
      expect(secondCall[2]).toBe(false); // not first arrival
    });
  });

  describe('fragment assembly', () => {
    it('assembles fragments in order', () => {
      const handler = vi.fn();
      assembler.onMessage(handler);

      // Fragment 0
      assembler.processFragment({
        messageId: 'msg-frag',
        fragmentIndex: 0,
        totalFragments: 2,
        data: btoa(String.fromCharCode(1, 2, 3)),
        pathId: 'path-a',
      });

      expect(handler).not.toHaveBeenCalled();
      expect(assembler.getPendingCount()).toBe(1);

      // Fragment 1
      assembler.processFragment({
        messageId: 'msg-frag',
        fragmentIndex: 1,
        totalFragments: 2,
        data: btoa(String.fromCharCode(4, 5, 6)),
        pathId: 'path-a',
      });

      expect(handler).toHaveBeenCalledOnce();
      const deliveredPayload = handler.mock.calls[0][1] as Uint8Array;
      expect(Array.from(deliveredPayload)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('assembles fragments out of order', () => {
      const handler = vi.fn();
      assembler.onMessage(handler);

      // Fragment 1 first
      assembler.processFragment({
        messageId: 'msg-frag',
        fragmentIndex: 1,
        totalFragments: 2,
        data: btoa(String.fromCharCode(4, 5, 6)),
        pathId: 'path-a',
      });

      // Fragment 0 second
      assembler.processFragment({
        messageId: 'msg-frag',
        fragmentIndex: 0,
        totalFragments: 2,
        data: btoa(String.fromCharCode(1, 2, 3)),
        pathId: 'path-a',
      });

      expect(handler).toHaveBeenCalledOnce();
      const deliveredPayload = handler.mock.calls[0][1] as Uint8Array;
      expect(Array.from(deliveredPayload)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('deduplicates already-assembled fragments', () => {
      assembler.processFragment({
        messageId: 'msg-frag',
        fragmentIndex: 0,
        totalFragments: 1,
        data: btoa(String.fromCharCode(1)),
        pathId: 'path-a',
      });

      const status = assembler.processFragment({
        messageId: 'msg-frag',
        fragmentIndex: 0,
        totalFragments: 1,
        data: btoa(String.fromCharCode(1)),
        pathId: 'path-b',
      });

      expect(status.isComplete).toBe(true);
    });
  });

  describe('status', () => {
    it('returns null for unknown message', () => {
      expect(assembler.getStatus('unknown')).toBeNull();
    });

    it('returns completed status for seen messages', () => {
      assembler.processMessage('msg-1', new Uint8Array([1]), 'path-a');
      const status = assembler.getStatus('msg-1');
      expect(status).toBeDefined();
      expect(status!.isComplete).toBe(true);
      expect(status!.winningPathId).toBe('path-a');
    });

    it('reports hasSeen correctly', () => {
      expect(assembler.hasSeen('msg-1')).toBe(false);
      assembler.processMessage('msg-1', new Uint8Array([1]), 'path-a');
      expect(assembler.hasSeen('msg-1')).toBe(true);
    });
  });
});
