/**
 * RelaySignalingChannel 單元測試（mock Firestore）— ADR-0023 P4-B
 * 驗 client 邏輯：channelId deterministic、ensureChannel 寫 participants、
 * send 帶 from/type/payload、subscribe 去重 + 略過自己送的 + 交付對方。
 * rules（只有 participants 可讀寫/非匿名）由 firestore-rules.spec 整合測驗。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/firebase', () => ({ db: {} as any }));

const mockSetDoc = vi.fn().mockResolvedValue(undefined);
const mockAddDoc = vi.fn().mockResolvedValue({ id: 'sig-x' });
let snapshotCb: ((snap: any) => void) | null = null;
const mockOnSnapshot = vi.fn((_q: any, cb: (snap: any) => void) => {
  snapshotCb = cb;
  return () => {};
});

vi.mock('firebase/firestore', () => ({
  collection: (...a: any[]) => ({ __col: a.slice(1).join('/') }),
  doc: (...a: any[]) => ({ __path: a.slice(1).join('/') }),
  setDoc: (...a: any[]) => mockSetDoc(...a),
  addDoc: (...a: any[]) => mockAddDoc(...a),
  onSnapshot: (...a: any[]) => mockOnSnapshot(...a),
  query: (...a: any[]) => ({ __q: a }),
  where: vi.fn().mockReturnValue('w'),
  orderBy: vi.fn().mockReturnValue('o'),
  limit: vi.fn().mockReturnValue('l'),
  Timestamp: {
    now: () => ({ toMillis: () => 1000 }),
    fromMillis: (m: number) => ({ toMillis: () => m }),
  },
}));

import { RelaySignalingChannel, relayChannelId } from '../../src/core/relay/RelaySignaling';

function fireSignals(docs: Array<{ signalId: string; from: string; type: string; payload?: unknown }>) {
  snapshotCb!({
    docChanges: () =>
      docs.map((d) => ({
        type: 'added',
        doc: { id: d.signalId, data: () => ({ from: d.from, type: d.type, payload: d.payload ?? {}, createdAt: 1000 }) },
      })),
  });
}

describe('RelaySignaling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotCb = null;
  });

  it('relayChannelId deterministic（排序後串接，雙向一致）', () => {
    expect(relayChannelId('b', 'a')).toBe('a__b');
    expect(relayChannelId('a', 'b')).toBe('a__b');
  });

  it('ensureChannel 寫 relaySignals/{channelId}，帶排序後 participants', async () => {
    const ch = new RelaySignalingChannel('uid-b', 'uid-a');
    expect(ch.getChannelId()).toBe('uid-a__uid-b');
    await ch.ensureChannel();
    const [ref, data] = mockSetDoc.mock.calls[0];
    expect(ref.__path).toBe('relaySignals/uid-a__uid-b');
    expect(data.participants).toEqual(['uid-a', 'uid-b']);
  });

  it('send 寫 signals 子集合，帶 from/type/payload', async () => {
    const ch = new RelaySignalingChannel('uid-a', 'uid-b');
    await ch.send('offer', { type: 'offer', sdp: 'v=0...' });
    const [col, data] = mockAddDoc.mock.calls[0];
    expect(col.__col).toBe('relaySignals/uid-a__uid-b/signals');
    expect(data).toMatchObject({ from: 'uid-a', type: 'offer', payload: { type: 'offer', sdp: 'v=0...' } });
  });

  it('subscribe：略過自己送的、去重、只交付對方的 signal', () => {
    const ch = new RelaySignalingChannel('uid-a', 'uid-b');
    const got: string[] = [];
    ch.subscribe((s) => got.push(`${s.from}:${s.type}`));

    fireSignals([
      { signalId: 's1', from: 'uid-a', type: 'offer' }, // 自己送的 → 略過
      { signalId: 's2', from: 'uid-b', type: 'answer' }, // 對方 → 交付
      { signalId: 's2', from: 'uid-b', type: 'answer' }, // 重播同 id → 去重
      { signalId: 's3', from: 'uid-b', type: 'ice' }, // 對方 → 交付
    ]);

    expect(got).toEqual(['uid-b:answer', 'uid-b:ice']);
  });
});
