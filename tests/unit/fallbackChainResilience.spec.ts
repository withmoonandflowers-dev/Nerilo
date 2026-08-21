/**
 * A2 回歸：Firestore 備援訂閱的序列化 chain 不得被單則例外毒化。
 *
 * 修復前：chain = chain.then(cb)，cb（onMessage / 解密）拋一次 → chain 變 rejected，
 * 此後所有 chain.then 的 callback 一律不執行，備援投遞從此永久靜默，且每則新訊息
 * 再產生一個 unhandled rejection。修復後每步各自 .catch，單則失敗只丟該則。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// db 佔位；本測試不碰真實 Firestore
vi.mock('../../src/config/firebase', () => ({ db: {} }));

// 只 mock 訂閱需要的出口；onSnapshot 交出 callback 供測試手動餵 snapshot
let snapshotCb: ((snap: unknown) => void) | null = null;
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  query: vi.fn(() => ({})),
  orderBy: vi.fn(() => ({})),
  limit: vi.fn(() => ({})),
  onSnapshot: vi.fn((_q: unknown, cb: (snap: unknown) => void) => {
    snapshotCb = cb;
    return () => {};
  }),
  addDoc: vi.fn(),
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
}));

import { subscribeToFirestoreMessages } from '../../src/services/FirestoreChatFallback';

function added(messageId: string, content: string) {
  return {
    type: 'added',
    doc: { data: () => ({ messageId, from: 'peer-a', content, timestamp: 1 }) },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FirestoreChatFallback chain 韌性（A2）', () => {
  beforeEach(() => {
    snapshotCb = null;
  });

  it('第一則 onMessage 拋錯，後續訊息仍照常投遞（chain 不被毒化）', async () => {
    const received: string[] = [];
    const onMessage = vi.fn((m: { messageId: string }) => {
      if (m.messageId === 'm1') throw new Error('reactive update boom');
      received.push(m.messageId);
    });

    subscribeToFirestoreMessages('room-1', onMessage);
    expect(snapshotCb).not.toBeNull();

    snapshotCb!({ docChanges: () => [added('m1', 'x'), added('m2', 'y'), added('m3', 'z')] });
    await flush();
    await flush();

    // m1 拋錯被吞掉，m2/m3 不受影響
    expect(received).toEqual(['m2', 'm3']);
  });

  it('後續 snapshot 的新訊息在先前例外後仍能投遞', async () => {
    const received: string[] = [];
    const onMessage = vi.fn((m: { messageId: string }) => {
      if (m.messageId === 'bad') throw new Error('boom');
      received.push(m.messageId);
    });

    subscribeToFirestoreMessages('room-1', onMessage);
    snapshotCb!({ docChanges: () => [added('bad', 'x')] });
    await flush();
    snapshotCb!({ docChanges: () => [added('later', 'y')] });
    await flush();
    await flush();

    expect(received).toEqual(['later']);
  });
});
