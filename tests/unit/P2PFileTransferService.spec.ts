/**
 * P2PFileTransferService smoke tests
 *
 * Covers the surface contract claimed in README:
 *  - sendFile chunks correctly given size / chunkSize
 *  - FILE_META → multiple FILE_CHUNK → FILE_END envelopes dispatched in order
 *  - Progress callback fires during transfer; onComplete fires at end
 *  - Receive flow: FILE_META → FILE_CHUNK → FILE_END reassembles into a File
 *  - cancelTransfer sets state and emits FILE_CANCEL
 *  - getProgress reflects bytesTransferred / total
 *
 * Uses fake timers to skip the per-chunk `setTimeout(0)` yields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { P2PEnvelope, FileTransferProgress } from '../../src/types';

class MockChannelBus {
  private subs: Map<string, (env: P2PEnvelope) => void | Promise<void>> = new Map();
  send = vi.fn().mockResolvedValue(undefined);
  subscribe(ns: string, handler: (env: P2PEnvelope) => void | Promise<void>): () => void {
    this.subs.set(ns, handler);
    return () => this.subs.delete(ns);
  }
  async emit(env: P2PEnvelope) {
    const h = this.subs.get(env.ns);
    if (h) await h(env);
  }
}

/** Minimal File polyfill — Node lacks the DOM File constructor */
class FakeFile {
  constructor(
    private readonly bytes: Uint8Array,
    public readonly name: string,
    public readonly type = 'application/octet-stream',
  ) {}
  get size() {
    return this.bytes.length;
  }
  slice(start: number, end: number) {
    const sliced = this.bytes.slice(start, end);
    return {
      arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength),
    };
  }
}

beforeEach(() => {
  // Provide a global File constructor so reassembly works (used in receiver path).
  // We do not need full fidelity — only its existence + name/type retention.
  if (typeof (globalThis as { File?: unknown }).File === 'undefined') {
    (globalThis as { File: unknown }).File = class {
      name: string;
      type: string;
      constructor(_parts: unknown[], name: string, opts?: { type?: string }) {
        this.name = name;
        this.type = opts?.type ?? '';
      }
    };
  }
  if (typeof (globalThis as { Blob?: unknown }).Blob === 'undefined') {
    (globalThis as { Blob: unknown }).Blob = class {
      constructor(_parts: unknown[], _opts?: { type?: string }) {}
    };
  }
});

describe('P2PFileTransferService (smoke)', () => {
  let bus: MockChannelBus;

  beforeEach(() => {
    bus = new MockChannelBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('chunks a file by the configured chunkSize', async () => {
    const { P2PFileTransferService } = await import('../../src/core/p2p/P2PFileTransferService');
    // chunkSize = 4 → 10 bytes split into 3 chunks (4 + 4 + 2)
    const service = new P2PFileTransferService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      'uid-self',
      'dev-1',
      4,
    );

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const file = new FakeFile(bytes, 'hello.bin') as unknown as File;

    const fileId = await service.sendFile(file);

    // Drain the setTimeout(0) yields inside sendChunks
    await vi.runAllTimersAsync();

    const types = bus.send.mock.calls.map((c) => (c[0] as P2PEnvelope).type);
    expect(types[0]).toBe('FILE_META');
    expect(types.filter((t) => t === 'FILE_CHUNK')).toHaveLength(3);
    expect(types[types.length - 1]).toBe('FILE_END');

    // metadata sanity
    const meta = bus.send.mock.calls[0][0] as P2PEnvelope;
    expect((meta.payload as { chunkCount: number }).chunkCount).toBe(3);
    expect((meta.payload as { fileId: string }).fileId).toBe(fileId);
  });

  it('reports progress and fires onComplete', async () => {
    const { P2PFileTransferService } = await import('../../src/core/p2p/P2PFileTransferService');
    const service = new P2PFileTransferService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      'uid-self',
      'dev-1',
      4,
    );

    const file = new FakeFile(new Uint8Array(10), 'p.bin') as unknown as File;
    const onProgress = vi.fn();
    const onComplete = vi.fn();

    const fileId = await service.sendFile(file, undefined, { onProgress, onComplete });
    await vi.runAllTimersAsync();

    expect(onProgress).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(fileId);

    const final = onProgress.mock.calls[onProgress.mock.calls.length - 1][0] as FileTransferProgress;
    expect(final.bytesTransferred).toBe(10);
    expect(final.totalBytes).toBe(10);
    expect(final.status).toBe('completed');
  });

  it('cancelTransfer marks the transfer cancelled and emits FILE_CANCEL', async () => {
    const { P2PFileTransferService } = await import('../../src/core/p2p/P2PFileTransferService');
    const service = new P2PFileTransferService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      'uid-self',
      'dev-1',
      4,
    );

    const file = new FakeFile(new Uint8Array(20), 'big.bin') as unknown as File;
    const fileId = await service.sendFile(file);
    // Cancel before chunks finish
    service.cancelTransfer(fileId);

    await vi.runAllTimersAsync();

    const types = bus.send.mock.calls.map((c) => (c[0] as P2PEnvelope).type);
    expect(types).toContain('FILE_CANCEL');

    const progress = service.getProgress(fileId);
    expect(progress?.status).toBe('cancelled');
  });

  it('receiving side reassembles FILE_META + FILE_CHUNK + FILE_END into a File', async () => {
    const { P2PFileTransferService } = await import('../../src/core/p2p/P2PFileTransferService');
    const service = new P2PFileTransferService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      'uid-recv',
      'dev-recv',
      4,
    );

    const fileId = 'file-abc';
    const meta = {
      fileId,
      fileName: 'received.bin',
      fileSize: 10,
      fileType: 'application/octet-stream',
      chunkCount: 3,
      chunkSize: 4,
    };

    await bus.emit({
      v: 1, ns: 'file', type: 'FILE_META',
      id: 'm', ts: Date.now(), from: 'uid-sender/dev',
      payload: meta,
    });

    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10]),
    ];
    for (let i = 0; i < chunks.length; i++) {
      const b64 = btoa(String.fromCharCode(...chunks[i]));
      await bus.emit({
        v: 1, ns: 'file', type: 'FILE_CHUNK',
        id: `c-${i}`, ts: Date.now(), from: 'uid-sender/dev',
        payload: { fileId, chunkIndex: i, data: b64 },
      });
    }

    await bus.emit({
      v: 1, ns: 'file', type: 'FILE_END',
      id: 'e', ts: Date.now(), from: 'uid-sender/dev',
      payload: { fileId },
    });

    const file = service.getFile(fileId);
    expect(file).not.toBeNull();
    expect(file?.name).toBe('received.bin');

    const progress = service.getProgress(fileId);
    expect(progress?.status).toBe('completed');
  });

  it('cleanup removes transfer state', async () => {
    const { P2PFileTransferService } = await import('../../src/core/p2p/P2PFileTransferService');
    const service = new P2PFileTransferService(
      bus as unknown as import('../../src/core/p2p/P2PChannelBus').P2PChannelBus,
      'uid-self',
      'dev-1',
      4,
    );

    const file = new FakeFile(new Uint8Array(8), 'x.bin') as unknown as File;
    const fileId = await service.sendFile(file);
    await vi.runAllTimersAsync();

    service.cleanup(fileId);
    expect(service.getProgress(fileId)).toBeNull();
    expect(service.getFile(fileId)).toBeNull();
  });
});
