/**
 * useFileTransfer unit tests.
 *
 * Mocks P2PFileTransferService and exercises:
 *   - sendFile delegates to the service and seeds a transfer entry
 *   - onIncomingFile creates an inbound transfer entry
 *   - onAnyProgress updates the existing entry
 *   - onAnyComplete (recv) surfaces a ReceivedFile and clears the entry
 *   - cancelTransfer calls the service and drops the entry
 *   - clearReceivedFile revokes the objectURL and removes from list
 *   - isReady tracks service availability
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileTransfer } from '../../src/features/chat/hooks/useFileTransfer';
import type { FileMetadata, FileTransferProgress } from '../../src/types';

type IncomingFileListener = (info: { metadata: FileMetadata; from: string }) => void;
type ProgressListener = (
  progress: FileTransferProgress & { direction: 'send' | 'recv'; metadata: FileMetadata },
) => void;
type CompleteListener = (info: {
  fileId: string;
  direction: 'send' | 'recv';
  file: File | null;
  metadata: FileMetadata;
}) => void;

function makeMockService() {
  const incomingListeners = new Set<IncomingFileListener>();
  const progressListeners = new Set<ProgressListener>();
  const completeListeners = new Set<CompleteListener>();

  return {
    sendFile: vi.fn().mockImplementation(async (_file: File) => 'file-id-1'),
    cancelTransfer: vi.fn(),
    onIncomingFile: (l: IncomingFileListener) => {
      incomingListeners.add(l);
      return () => incomingListeners.delete(l);
    },
    onAnyProgress: (l: ProgressListener) => {
      progressListeners.add(l);
      return () => progressListeners.delete(l);
    },
    onAnyComplete: (l: CompleteListener) => {
      completeListeners.add(l);
      return () => completeListeners.delete(l);
    },
    // helpers
    emitIncoming(info: { metadata: FileMetadata; from: string }) {
      incomingListeners.forEach((l) => l(info));
    },
    emitProgress(p: FileTransferProgress & { direction: 'send' | 'recv'; metadata: FileMetadata }) {
      progressListeners.forEach((l) => l(p));
    },
    emitComplete(info: { fileId: string; direction: 'send' | 'recv'; file: File | null; metadata: FileMetadata }) {
      completeListeners.forEach((l) => l(info));
    },
  };
}

const METADATA: FileMetadata = {
  fileId: 'file-id-1',
  fileName: 'hello.txt',
  fileSize: 16,
  fileType: 'text/plain',
  chunkCount: 1,
  chunkSize: 64 * 1024,
};

describe('useFileTransfer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Polyfill URL.createObjectURL for jsdom
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isReady reflects service availability', () => {
    const r1 = renderHook(() => useFileTransfer({ fileTransferService: null }));
    expect(r1.result.current.isReady).toBe(false);

    const service = makeMockService();
    const r2 = renderHook(() =>
      useFileTransfer({ fileTransferService: service as never }),
    );
    expect(r2.result.current.isReady).toBe(true);
  });

  it('sendFile delegates to the service and seeds a transfer entry', async () => {
    const service = makeMockService();
    const { result } = renderHook(() =>
      useFileTransfer({ fileTransferService: service as never }),
    );

    const file = new File([new Uint8Array(16)], 'hello.txt', { type: 'text/plain' });
    await act(async () => {
      await result.current.sendFile(file);
    });

    expect(service.sendFile).toHaveBeenCalledTimes(1);
    expect(result.current.transfers).toHaveLength(1);
    expect(result.current.transfers[0]).toMatchObject({
      fileId: 'file-id-1',
      direction: 'send',
      status: 'transferring',
      fileName: 'hello.txt',
      fileSize: 16,
    });
  });

  it('emits an inbound transfer entry when onIncomingFile fires', () => {
    const service = makeMockService();
    const { result } = renderHook(() =>
      useFileTransfer({ fileTransferService: service as never }),
    );

    act(() => {
      service.emitIncoming({ metadata: METADATA, from: 'remote/dev' });
    });

    expect(result.current.transfers).toHaveLength(1);
    expect(result.current.transfers[0]).toMatchObject({
      fileId: METADATA.fileId,
      direction: 'recv',
      status: 'transferring',
      fileName: METADATA.fileName,
      fileSize: METADATA.fileSize,
    });
  });

  it('updates entry on progress ticks', () => {
    const service = makeMockService();
    const { result } = renderHook(() =>
      useFileTransfer({ fileTransferService: service as never }),
    );

    act(() => {
      service.emitIncoming({ metadata: METADATA, from: 'remote/dev' });
    });
    act(() => {
      service.emitProgress({
        fileId: METADATA.fileId,
        bytesTransferred: 8,
        totalBytes: 16,
        percentage: 50,
        status: 'transferring',
        direction: 'recv',
        metadata: METADATA,
      });
    });

    expect(result.current.transfers[0].percentage).toBe(50);
    expect(result.current.transfers[0].bytesTransferred).toBe(8);
  });

  it('surfaces a ReceivedFile on inbound complete and removes the entry after linger', async () => {
    const service = makeMockService();
    const onReceived = vi.fn();
    const { result } = renderHook(() =>
      useFileTransfer({
        fileTransferService: service as never,
        onFileReceived: onReceived,
      }),
    );

    act(() => {
      service.emitIncoming({ metadata: METADATA, from: 'remote/dev' });
    });
    const file = new File(['hello world bin '], METADATA.fileName, { type: METADATA.fileType });
    act(() => {
      service.emitComplete({
        fileId: METADATA.fileId,
        direction: 'recv',
        file,
        metadata: METADATA,
      });
    });

    expect(result.current.receivedFiles).toHaveLength(1);
    expect(result.current.receivedFiles[0]).toMatchObject({
      fileId: METADATA.fileId,
      fileType: METADATA.fileType,
    });
    expect(onReceived).toHaveBeenCalledTimes(1);

    // The transfer entry should disappear after the linger window
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.transfers).toHaveLength(0);
  });

  it('does NOT surface a ReceivedFile on outbound complete', () => {
    const service = makeMockService();
    const onReceived = vi.fn();
    const { result } = renderHook(() =>
      useFileTransfer({
        fileTransferService: service as never,
        onFileReceived: onReceived,
      }),
    );

    const file = new File([new Uint8Array(16)], METADATA.fileName, { type: METADATA.fileType });
    act(() => {
      service.emitComplete({
        fileId: METADATA.fileId,
        direction: 'send',
        file,
        metadata: METADATA,
      });
    });

    expect(result.current.receivedFiles).toHaveLength(0);
    expect(onReceived).not.toHaveBeenCalled();
  });

  it('cancelTransfer calls the service and drops the entry', async () => {
    const service = makeMockService();
    const { result } = renderHook(() =>
      useFileTransfer({ fileTransferService: service as never }),
    );

    const file = new File([new Uint8Array(16)], 'big.bin');
    await act(async () => {
      await result.current.sendFile(file);
    });
    expect(result.current.transfers).toHaveLength(1);

    act(() => {
      result.current.cancelTransfer('file-id-1');
    });
    expect(service.cancelTransfer).toHaveBeenCalledWith('file-id-1');
    expect(result.current.transfers).toHaveLength(0);
  });

  it('clearReceivedFile revokes the object URL and removes it', async () => {
    const service = makeMockService();
    const { result } = renderHook(() =>
      useFileTransfer({ fileTransferService: service as never }),
    );

    const file = new File(['x'], METADATA.fileName, { type: METADATA.fileType });
    act(() => {
      service.emitComplete({
        fileId: METADATA.fileId,
        direction: 'recv',
        file,
        metadata: METADATA,
      });
    });
    expect(result.current.receivedFiles).toHaveLength(1);

    act(() => {
      result.current.clearReceivedFile(METADATA.fileId);
    });
    expect(global.URL.revokeObjectURL).toHaveBeenCalled();
    expect(result.current.receivedFiles).toHaveLength(0);
  });
});
