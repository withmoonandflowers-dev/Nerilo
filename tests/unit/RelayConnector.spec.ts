/**
 * RelayConnector 測試（P4-B 陌生節點連線編排）
 *
 * 注入假 makeConn / watchMyChannels，測「編排邏輯」——initiator initialize（內含建 DataChannel
 * + 送 offer）、responder 對來連建連、對稱去重（不回應自己發起的）、dedup、角色旗標。
 * 真實 WebRTC 連線屬部署驗證（tests/e2e-vue/relay-connect.spec.ts）。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { RelayConnector, type RelayConnLike } from '../../src/core/relay/RelayConnector';
import { relayChannelId } from '../../src/core/relay/RelaySignaling';

function makeFakeConn(): RelayConnLike & { initialize: ReturnType<typeof vi.fn> } {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue('connecting'),
    close: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe('RelayConnector — initiator', () => {
  it('connectToRelayNode：以 initiator 角色建連線 + initialize（內含送 offer）', async () => {
    const conns: Array<ReturnType<typeof makeFakeConn>> = [];
    const roles: boolean[] = [];
    const rc = new RelayConnector('me', {
      makeConn: (_cid, _l, _r, isInitiator) => {
        roles.push(isInitiator);
        const c = makeFakeConn();
        conns.push(c);
        return c;
      },
      watchMyChannels: () => () => undefined,
    });

    const conn = await rc.connectToRelayNode('stranger');
    expect(conns).toHaveLength(1);
    expect(roles).toEqual([true]); // 主動方
    expect(conns[0]!.initialize).toHaveBeenCalledTimes(1);
    expect(conn).toBe(conns[0]);
    expect(rc.activeCount()).toBe(1);
  });

  it('連自己 → 擲錯', async () => {
    const rc = new RelayConnector('me', { makeConn: makeFakeConn, watchMyChannels: () => () => undefined });
    await expect(rc.connectToRelayNode('me')).rejects.toThrow();
  });

  it('同一陌生節點連兩次 → 不重複建連', async () => {
    let n = 0;
    const rc = new RelayConnector('me', {
      makeConn: () => { n++; return makeFakeConn(); },
      watchMyChannels: () => () => undefined,
    });
    const a = await rc.connectToRelayNode('stranger');
    const b = await rc.connectToRelayNode('stranger');
    expect(a).toBe(b);
    expect(n).toBe(1);
  });
});

describe('RelayConnector — responder (startListening)', () => {
  it('對「來連」channel 建 responder 連線並回呼', async () => {
    let emit: ((channelId: string, participants: string[]) => void) | null = null;
    const rc = new RelayConnector('me', {
      makeConn: makeFakeConn,
      watchMyChannels: (_uid, onAdded) => { emit = onAdded; return () => undefined; },
    });

    const onIncoming = vi.fn();
    rc.startListening(onIncoming);

    // 對方(other)發起的 channel 出現
    emit!(relayChannelId('me', 'other'), ['me', 'other'].sort());
    await Promise.resolve(); await Promise.resolve();

    expect(onIncoming).toHaveBeenCalledTimes(1);
    expect(onIncoming.mock.calls[0]![1]).toBe('other'); // remoteUid
    expect(rc.activeCount()).toBe(1);
  });

  it('略過「自己發起」的 channel（不回應自己）', async () => {
    let emit: ((channelId: string, participants: string[]) => void) | null = null;
    const rc = new RelayConnector('me', {
      makeConn: makeFakeConn,
      watchMyChannels: (_uid, onAdded) => { emit = onAdded; return () => undefined; },
    });
    const onIncoming = vi.fn();
    rc.startListening(onIncoming);

    // 我先主動連 stranger（記為 initiated），監聽看到同一 channel 應略過
    await rc.connectToRelayNode('stranger');
    emit!(relayChannelId('me', 'stranger'), ['me', 'stranger'].sort());
    await Promise.resolve();

    expect(onIncoming).not.toHaveBeenCalled(); // 不對自己發起的當 responder
  });

  it('同一 channel 出現兩次 → 只建一次', async () => {
    let emit: ((channelId: string, participants: string[]) => void) | null = null;
    let n = 0;
    const rc = new RelayConnector('me', {
      makeConn: () => { n++; return makeFakeConn(); },
      watchMyChannels: (_uid, onAdded) => { emit = onAdded; return () => undefined; },
    });
    rc.startListening();
    const cid = relayChannelId('me', 'other');
    emit!(cid, ['me', 'other'].sort());
    emit!(cid, ['me', 'other'].sort());
    await Promise.resolve();
    expect(n).toBe(1);
  });

  it('closeAll 關閉全部連線', async () => {
    const conns: Array<ReturnType<typeof makeFakeConn>> = [];
    const rc = new RelayConnector('me', {
      makeConn: () => { const c = makeFakeConn(); conns.push(c); return c; },
      watchMyChannels: () => () => undefined,
    });
    await rc.connectToRelayNode('s1');
    await rc.connectToRelayNode('s2');
    await rc.closeAll();
    expect(conns.every((c) => (c.close as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    expect(rc.activeCount()).toBe(0);
  });
});
