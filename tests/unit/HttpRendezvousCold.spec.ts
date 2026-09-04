/**
 * Spec 030 B2：既有 warm/cold 選擇器可把 HTTP rendezvous 當注入的 cold。
 * 本測試不涵蓋 cold 失敗後重回 warm，該機制仍未實作。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarmColdSignalingTransport } from '../../src/core/p2p/WarmColdSignalingTransport';
import { createHttpSignaling } from '../../src/sdk/httpSignaling';
import type { SignalingTransport } from '../../src/core/p2p/SignalingTransport.types';

function warmTransport(send: () => Promise<void>): SignalingTransport {
  return {
    subscribe: () => () => {},
    send,
    cleanupOlderThan: async () => {},
    cleanupOwn: async () => {},
  };
}

describe('HTTP rendezvous cold 注入', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('有 warm 路徑時只走 warm，不建立 HTTP 請求', async () => {
    const warmSend = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const http = createHttpSignaling('http://rendezvous.test:9973');
    const transport = new WarmColdSignalingTransport(
      warmTransport(warmSend),
      () => http('room-1', 'mesh-a-b', 'remote'),
      () => true,
      'mesh-a-b'
    );

    await transport.send({ type: 'offer' });

    expect(warmSend).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warm 不可用時改走注入的 HTTP cold', async () => {
    const warmSend = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const http = createHttpSignaling('http://rendezvous.test:9973/');
    const transport = new WarmColdSignalingTransport(
      warmTransport(warmSend),
      () => http('room 1', 'mesh-a-b', 'remote'),
      () => false,
      'mesh-a-b'
    );

    await transport.send({ type: 'offer' });

    expect(warmSend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://rendezvous.test:9973/rooms/room%201/signals',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
