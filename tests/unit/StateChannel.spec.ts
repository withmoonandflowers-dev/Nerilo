/**
 * StateChannel 測試（不可靠二進位狀態幀通道，ADR-0019）
 *
 * - open 時送幀成功、非 open 時丟棄（lossy）
 * - 收到 binary 幀吐給 handler；非 binary 忽略
 * - onFrame 取消訂閱
 * - close 清理
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateChannel } from '../../src/core/p2p/StateChannel';

interface MockDC {
  readyState: RTCDataChannelState;
  binaryType: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeMockDC(state: RTCDataChannelState = 'open'): MockDC {
  return {
    readyState: state,
    binaryType: 'blob',
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe('StateChannel', () => {
  let dc: MockDC;
  let sc: StateChannel;

  beforeEach(() => {
    dc = makeMockDC('open');
    sc = new StateChannel(dc as unknown as RTCDataChannel);
  });

  it('建構時設 binaryType=arraybuffer', () => {
    expect(dc.binaryType).toBe('arraybuffer');
  });

  it('open 時送幀成功', () => {
    const frame = new Uint8Array([1, 2, 3]);
    expect(sc.send(frame)).toBe(true);
    expect(dc.send).toHaveBeenCalledWith(frame);
  });

  it('非 open 時丟棄（lossy，不排隊）', () => {
    dc.readyState = 'connecting';
    expect(sc.send(new Uint8Array([1]))).toBe(false);
    expect(dc.send).not.toHaveBeenCalled();
  });

  it('send 擲錯時回 false 不炸', () => {
    dc.send.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(sc.send(new Uint8Array([1]))).toBe(false);
  });

  it('收到 ArrayBuffer 幀吐給 handler', () => {
    const received: Uint8Array[] = [];
    sc.onFrame((f) => received.push(f));

    const buf = new Uint8Array([9, 8, 7]).buffer;
    dc.onmessage!({ data: buf } as MessageEvent);

    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!)).toEqual([9, 8, 7]);
  });

  it('收到 TypedArray view 幀也還原', () => {
    const received: Uint8Array[] = [];
    sc.onFrame((f) => received.push(f));
    dc.onmessage!({ data: new Uint8Array([5, 6]) } as MessageEvent);
    expect(Array.from(received[0]!)).toEqual([5, 6]);
  });

  it('非 binary（字串）幀被忽略', () => {
    const received: Uint8Array[] = [];
    sc.onFrame((f) => received.push(f));
    dc.onmessage!({ data: 'not-binary' } as MessageEvent);
    expect(received).toHaveLength(0);
  });

  it('onFrame 取消訂閱後不再收到', () => {
    const received: Uint8Array[] = [];
    const unsub = sc.onFrame((f) => received.push(f));
    unsub();
    dc.onmessage!({ data: new Uint8Array([1]).buffer } as MessageEvent);
    expect(received).toHaveLength(0);
  });

  it('一個 handler 擲錯不影響其他 handler', () => {
    const good = vi.fn();
    sc.onFrame(() => {
      throw new Error('bad handler');
    });
    sc.onFrame(good);
    dc.onmessage!({ data: new Uint8Array([1]).buffer } as MessageEvent);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('close 清 handler 並關通道', () => {
    const h = vi.fn();
    sc.onFrame(h);
    sc.close();
    expect(dc.close).toHaveBeenCalled();
    dc.onmessage!({ data: new Uint8Array([1]).buffer } as MessageEvent);
    expect(h).not.toHaveBeenCalled();
  });
});
