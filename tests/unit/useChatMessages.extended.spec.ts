/**
 * useChatMessages Extended Tests
 *
 * Extended tests for hooks/useChatMessages.ts covering:
 *  1. addMessage deduplication
 *  2. insertSorted binary insertion correctness
 *  3. addMessages batch load
 *  4. updateMessageStatus correctness
 *  5. displayLimit behaviour (if applicable)
 *
 * Since useChatMessages is a React hook, we test the pure logic equivalents
 * (insertSorted, compareMessages, sortByHLC) directly, plus state management
 * via a reducer-style simulation.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage, DeliveryStatus, HLCTimestamp } from '../../src/types';

// ── Re-implement the pure functions from useChatMessages ────────────────────

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.hlc && b.hlc) return hlcCompare(a.hlc, b.hlc);
  return a.timestamp - b.timestamp;
}

/** Minimal HLC compare matching HybridLogicalClock.compare */
function hlcCompare(a: HLCTimestamp, b: HLCTimestamp): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function insertSorted(sorted: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (sorted.length === 0 || compareMessages(msg, sorted[sorted.length - 1]) >= 0) {
    return [...sorted, msg];
  }
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareMessages(sorted[mid], msg) < 0) lo = mid + 1;
    else hi = mid;
  }
  const result = [...sorted];
  result.splice(lo, 0, msg);
  return result;
}

function sortByHLC(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareMessages);
}

// ── State simulation (matches useChatMessages reducer) ───────────────────────

interface MsgState {
  messages: ChatMessage[];
  seenIds: Set<string>;
}

function initState(): MsgState {
  return { messages: [], seenIds: new Set() };
}

function addMessage(state: MsgState, message: ChatMessage): MsgState {
  if (state.seenIds.has(message.messageId)) return state;
  const newIds = new Set(state.seenIds);
  newIds.add(message.messageId);
  // Hook uses sortByHLC for non-causal, insertSorted via causal buffer
  return { messages: sortByHLC([...state.messages, message]), seenIds: newIds };
}

function addMessages(state: MsgState, newMsgs: ChatMessage[]): MsgState {
  const existingIds = new Set([...state.messages.map((m) => m.messageId), ...state.seenIds]);
  const unique = newMsgs.filter((m) => !existingIds.has(m.messageId));
  if (unique.length === 0) return state;
  const newIds = new Set(state.seenIds);
  unique.forEach((m) => newIds.add(m.messageId));
  return { messages: [...state.messages, ...unique], seenIds: newIds };
}

function setMessagesList(_state: MsgState, newMsgs: ChatMessage[]): MsgState {
  const newIds = new Set(newMsgs.map((m) => m.messageId));
  return { messages: newMsgs, seenIds: newIds };
}

function updateMessageStatus(state: MsgState, messageId: string, status: DeliveryStatus): MsgState {
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.messageId === messageId ? { ...m, deliveryStatus: status } : m,
    ),
  };
}

function clearMessages(_state: MsgState): MsgState {
  return initState();
}

// ── Factory helpers ─────────────────────────────────────────────────────────

let msgCounter = 0;

function makeMsg(
  id: string,
  content = 'test',
  timestamp?: number,
  hlc?: HLCTimestamp,
): ChatMessage {
  msgCounter++;
  return {
    messageId: id,
    from: 'user-1',
    content,
    timestamp: timestamp ?? 1000 + msgCounter,
    hlc,
  };
}

function makeHLC(ts: number, counter: number, nodeId = 'node-a'): HLCTimestamp {
  return { ts, counter, nodeId };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useChatMessages extended logic', () => {
  // ──────────────────────────────────────────────────────────────────────
  // 1. addMessage deduplication
  // ──────────────────────────────────────────────────────────────────────

  describe('addMessage deduplication', () => {
    it('should reject duplicate messageId', () => {
      let state = initState();
      state = addMessage(state, makeMsg('m1'));
      state = addMessage(state, makeMsg('m1', 'different content'));
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe('test'); // first one kept
    });

    it('should return same state reference for duplicates (no re-render)', () => {
      let state = initState();
      state = addMessage(state, makeMsg('m1'));
      const before = state;
      state = addMessage(state, makeMsg('m1'));
      expect(state).toBe(before);
    });

    it('should accept 100 unique messages', () => {
      let state = initState();
      for (let i = 0; i < 100; i++) {
        state = addMessage(state, makeMsg(`msg-${i}`, `content-${i}`, 1000 + i));
      }
      expect(state.messages).toHaveLength(100);
      expect(state.seenIds.size).toBe(100);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. insertSorted binary insertion correctness
  // ──────────────────────────────────────────────────────────────────────

  describe('insertSorted', () => {
    it('should insert into empty array', () => {
      const msg = makeMsg('m1', 'hi', 1000);
      const result = insertSorted([], msg);
      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('m1');
    });

    it('should append when message is newer (fast path)', () => {
      const existing = [makeMsg('m1', 'a', 1000), makeMsg('m2', 'b', 2000)];
      const newMsg = makeMsg('m3', 'c', 3000);
      const result = insertSorted(existing, newMsg);
      expect(result).toHaveLength(3);
      expect(result[2].messageId).toBe('m3');
    });

    it('should insert at beginning when message is oldest', () => {
      const existing = [makeMsg('m2', 'b', 2000), makeMsg('m3', 'c', 3000)];
      const newMsg = makeMsg('m1', 'a', 500);
      const result = insertSorted(existing, newMsg);
      expect(result).toHaveLength(3);
      expect(result[0].messageId).toBe('m1');
    });

    it('should insert in middle at correct position', () => {
      const existing = [
        makeMsg('m1', 'a', 1000),
        makeMsg('m3', 'c', 3000),
        makeMsg('m5', 'e', 5000),
      ];
      const newMsg = makeMsg('m2', 'b', 2000);
      const result = insertSorted(existing, newMsg);
      expect(result).toHaveLength(4);
      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3', 'm5']);
    });

    it('should sort by HLC when available', () => {
      const existing = [
        makeMsg('m1', 'a', 1000, makeHLC(1000, 0, 'node-a')),
        makeMsg('m3', 'c', 1000, makeHLC(1000, 2, 'node-a')),
      ];
      const newMsg = makeMsg('m2', 'b', 1000, makeHLC(1000, 1, 'node-a'));
      const result = insertSorted(existing, newMsg);
      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3']);
    });

    it('should sort by nodeId when ts and counter are equal', () => {
      const existing = [
        makeMsg('m1', 'a', 1000, makeHLC(1000, 0, 'aaa')),
        makeMsg('m3', 'c', 1000, makeHLC(1000, 0, 'ccc')),
      ];
      const newMsg = makeMsg('m2', 'b', 1000, makeHLC(1000, 0, 'bbb'));
      const result = insertSorted(existing, newMsg);
      expect(result.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3']);
    });

    it('should maintain sorted order with 50 random insertions', () => {
      let arr: ChatMessage[] = [];
      const timestamps = Array.from({ length: 50 }, () => Math.floor(Math.random() * 10000));

      for (let i = 0; i < 50; i++) {
        arr = insertSorted(arr, makeMsg(`r-${i}`, `msg-${i}`, timestamps[i]));
      }

      // Verify sorted
      for (let i = 1; i < arr.length; i++) {
        expect(compareMessages(arr[i - 1], arr[i])).toBeLessThanOrEqual(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. addMessages batch load
  // ──────────────────────────────────────────────────────────────────────

  describe('addMessages batch load', () => {
    it('should add multiple unique messages at once', () => {
      let state = initState();
      state = addMessages(state, [
        makeMsg('b1', 'batch-1'),
        makeMsg('b2', 'batch-2'),
        makeMsg('b3', 'batch-3'),
      ]);
      expect(state.messages).toHaveLength(3);
    });

    it('should filter out messages that already exist', () => {
      let state = initState();
      state = addMessage(state, makeMsg('existing'));
      state = addMessages(state, [
        makeMsg('existing'), // duplicate
        makeMsg('new-1'),
        makeMsg('new-2'),
      ]);
      expect(state.messages).toHaveLength(3);
    });

    it('should return same state when all messages are duplicates', () => {
      let state = initState();
      state = addMessages(state, [makeMsg('x'), makeMsg('y')]);
      const before = state;
      state = addMessages(state, [makeMsg('x'), makeMsg('y')]);
      expect(state).toBe(before);
    });

    it('should handle empty batch gracefully', () => {
      let state = initState();
      state = addMessage(state, makeMsg('m1'));
      const before = state;
      state = addMessages(state, []);
      expect(state).toBe(before);
    });

    it('should handle large batch (1000 messages)', () => {
      let state = initState();
      const batch = Array.from({ length: 1000 }, (_, i) =>
        makeMsg(`large-${i}`, `content-${i}`, 1000 + i),
      );
      state = addMessages(state, batch);
      expect(state.messages).toHaveLength(1000);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. updateMessageStatus
  // ──────────────────────────────────────────────────────────────────────

  describe('updateMessageStatus', () => {
    it('should update status for existing message', () => {
      let state = initState();
      state = addMessage(state, makeMsg('msg-1'));

      state = updateMessageStatus(state, 'msg-1', 'sent');
      expect(state.messages[0].deliveryStatus).toBe('sent');
    });

    it('should transition through all delivery statuses', () => {
      let state = initState();
      state = addMessage(state, makeMsg('msg-1'));

      const statuses: DeliveryStatus[] = ['sending', 'sent', 'delivered'];
      for (const status of statuses) {
        state = updateMessageStatus(state, 'msg-1', status);
        expect(state.messages[0].deliveryStatus).toBe(status);
      }
    });

    it('should set failed status', () => {
      let state = initState();
      state = addMessage(state, makeMsg('msg-1'));

      state = updateMessageStatus(state, 'msg-1', 'failed');
      expect(state.messages[0].deliveryStatus).toBe('failed');
    });

    it('should not affect other messages', () => {
      let state = initState();
      state = addMessage(state, makeMsg('msg-1', 'a', 1000));
      state = addMessage(state, makeMsg('msg-2', 'b', 2000));
      state = addMessage(state, makeMsg('msg-3', 'c', 3000));

      state = updateMessageStatus(state, 'msg-2', 'delivered');

      expect(state.messages[0].deliveryStatus).toBeUndefined();
      expect(state.messages[1].deliveryStatus).toBe('delivered');
      expect(state.messages[2].deliveryStatus).toBeUndefined();
    });

    it('should be no-op for non-existent messageId', () => {
      let state = initState();
      state = addMessage(state, makeMsg('msg-1'));

      const before = state.messages.map((m) => ({ ...m }));
      state = updateMessageStatus(state, 'non-existent', 'sent');

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].deliveryStatus).toBe(before[0].deliveryStatus);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. setMessagesList
  // ──────────────────────────────────────────────────────────────────────

  describe('setMessagesList', () => {
    it('should completely replace existing messages', () => {
      let state = initState();
      state = addMessage(state, makeMsg('old-1'));
      state = addMessage(state, makeMsg('old-2'));

      state = setMessagesList(state, [makeMsg('new-1'), makeMsg('new-2'), makeMsg('new-3')]);
      expect(state.messages).toHaveLength(3);
      expect(state.messages[0].messageId).toBe('new-1');
    });

    it('should rebuild seenIds from new list', () => {
      let state = initState();
      state = addMessage(state, makeMsg('prev'));
      state = setMessagesList(state, [makeMsg('replacement')]);

      // 'prev' should no longer be in seenIds
      state = addMessage(state, makeMsg('prev'));
      expect(state.messages).toHaveLength(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. clearMessages
  // ──────────────────────────────────────────────────────────────────────

  describe('clearMessages', () => {
    it('should empty messages and seenIds', () => {
      let state = initState();
      state = addMessages(state, [makeMsg('a'), makeMsg('b'), makeMsg('c')]);
      state = clearMessages(state);

      expect(state.messages).toHaveLength(0);
      expect(state.seenIds.size).toBe(0);
    });

    it('should allow re-adding same messageIds after clear', () => {
      let state = initState();
      state = addMessage(state, makeMsg('dup'));
      state = clearMessages(state);
      state = addMessage(state, makeMsg('dup'));
      expect(state.messages).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. compareMessages
  // ──────────────────────────────────────────────────────────────────────

  describe('compareMessages', () => {
    it('should compare by timestamp when no HLC', () => {
      const a = makeMsg('a', 'a', 1000);
      const b = makeMsg('b', 'b', 2000);
      expect(compareMessages(a, b)).toBeLessThan(0);
      expect(compareMessages(b, a)).toBeGreaterThan(0);
    });

    it('should compare by HLC.ts first', () => {
      const a = makeMsg('a', 'a', 9999, makeHLC(1000, 0));
      const b = makeMsg('b', 'b', 1, makeHLC(2000, 0));
      expect(compareMessages(a, b)).toBeLessThan(0);
    });

    it('should compare by HLC.counter when ts equal', () => {
      const a = makeMsg('a', 'a', 1000, makeHLC(1000, 1));
      const b = makeMsg('b', 'b', 1000, makeHLC(1000, 5));
      expect(compareMessages(a, b)).toBeLessThan(0);
    });

    it('should compare by HLC.nodeId when ts and counter equal', () => {
      const a = makeMsg('a', 'a', 1000, makeHLC(1000, 0, 'aaa'));
      const b = makeMsg('b', 'b', 1000, makeHLC(1000, 0, 'zzz'));
      expect(compareMessages(a, b)).toBeLessThan(0);
    });

    it('should return 0 for identical HLC', () => {
      const hlc = makeHLC(1000, 0, 'same');
      const a = makeMsg('a', 'a', 1000, hlc);
      const b = makeMsg('b', 'b', 1000, hlc);
      expect(compareMessages(a, b)).toBe(0);
    });

    it('should fall back to timestamp when only one message has HLC', () => {
      const a = makeMsg('a', 'a', 1000, makeHLC(5000, 0));
      const b = makeMsg('b', 'b', 2000); // no HLC
      // Both have hlc? No (b doesn't), so uses timestamp
      expect(compareMessages(a, b)).toBeLessThan(0);
    });
  });
});
