import { describe, it, expect } from 'vitest';
import {
  InMemorySignalingHub,
  InMemorySignalingTransport,
} from '../../src/core/p2p/InMemorySignalingTransport';
import type { RawSignalDoc, SignalingFactory } from '../../src/core/p2p/SignalingTransport';

/**
 * 證明 SignalingTransport 注入縫真的可脫離 Firebase:兩個 peer 共用一顆記憶體 Hub 即互通,
 * 且語義鏡像 RoomSignalingTransport(cutoff 過濾、回放既有、signalId 由傳輸端指派)。
 */
describe('InMemorySignalingTransport (P2a 注入證明)', () => {
  it('A.send → B.subscribe 收得到(同房互通,無 Firebase)', () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingTransport(hub, 'room1', 'mesh-a-b');
    const b = new InMemorySignalingTransport(hub, 'room1', 'mesh-a-b');
    const got: RawSignalDoc[] = [];
    b.subscribe(0, (d) => got.push(d));
    void a.send({ from: 'a', type: 'offer', channelLabel: 'mesh-a-b', createdAt: 100 });
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('a');
    expect(got[0].type).toBe('offer');
    expect(got[0].signalId).toBeTruthy(); // 傳輸端指派 id
  });

  it('cutoffMs 過濾:早於 cutoff 的既有不回放,晚於的回放', () => {
    const hub = new InMemorySignalingHub();
    const a = new InMemorySignalingTransport(hub, 'r', 'c');
    void a.send({ from: 'a', createdAt: 50 });   // 早
    void a.send({ from: 'a', createdAt: 150 });  // 晚
    const seen: number[] = [];
    new InMemorySignalingTransport(hub, 'r', 'c').subscribe(100, (d) =>
      seen.push((d as unknown as { createdAt: number }).createdAt)
    );
    expect(seen).toEqual([150]);
  });

  it('不同房互不干擾', () => {
    const hub = new InMemorySignalingHub();
    const got: RawSignalDoc[] = [];
    new InMemorySignalingTransport(hub, 'roomX', 'c').subscribe(0, (d) => got.push(d));
    void new InMemorySignalingTransport(hub, 'roomY', 'c').send({ from: 'z', createdAt: 1 });
    expect(got).toHaveLength(0);
  });

  it('cleanupOwn 只清自己這條 channel 的', () => {
    const hub = new InMemorySignalingHub();
    const t = new InMemorySignalingTransport(hub, 'r', 'chA');
    void t.send({ from: 'me', channelLabel: 'chA', createdAt: 1 });
    void new InMemorySignalingTransport(hub, 'r', 'chB').send({ from: 'me', channelLabel: 'chB', createdAt: 1 });
    void t.cleanupOwn('me');
    const seen: RawSignalDoc[] = [];
    new InMemorySignalingTransport(hub, 'r', 'x').subscribe(0, (d) => seen.push(d));
    expect(seen.map((d) => d.channelLabel)).toEqual(['chB']); // chA 已清、chB 留著
  });

  it('可當 SignalingFactory 注入(型別相容)', () => {
    const hub = new InMemorySignalingHub();
    const factory: SignalingFactory = (roomId, channelLabel) =>
      new InMemorySignalingTransport(hub, roomId, channelLabel);
    const t = factory('r', 'mesh-x-y');
    expect(typeof t.subscribe).toBe('function');
    expect(typeof t.send).toBe('function');
  });
});
