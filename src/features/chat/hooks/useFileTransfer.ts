/**
 * useFileTransfer — UI-layer wrapper around P2PFileTransferService.
 *
 * Exposes:
 *   - sendFile(file)            — chunks + sends, returns the fileId
 *   - transfers                 — live progress for inbound + outbound
 *   - receivedFiles             — fully-arrived inbound files ready for download
 *   - cancelTransfer(fileId)    — abort an in-flight outbound send
 *   - clearReceivedFile(fileId) — drop from the local list once user has saved it
 *
 * Built on the service's onIncomingFile / onAnyProgress / onAnyComplete
 * listeners, so we never poll.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { P2PFileTransferService } from '../../../core/p2p/P2PFileTransferService';
import type { FileTransferProgress, FileMetadata } from '../../../types';
import { logger } from '../../../utils/logger';

export interface ReceivedFile {
  fileId: string;
  file: File;
  receivedAt: number;
  /** Object URL for image preview / download href. Revoked on clearReceivedFile. */
  objectUrl: string;
  fileType: string;
}

export interface TransferEntry extends FileTransferProgress {
  fileName: string;
  fileSize: number;
  fileType: string;
  direction: 'send' | 'recv';
}

export interface UseFileTransferOptions {
  /** P2PFileTransferService — null until the DataChannel is open. */
  fileTransferService: P2PFileTransferService | null;
  /** Notified when a fully-assembled inbound file arrives. */
  onFileReceived?: (received: ReceivedFile) => void;
}

export interface UseFileTransferResult {
  /** Live progress for inbound + outbound transfers in flight. */
  transfers: TransferEntry[];
  /** Inbound files that have fully arrived. */
  receivedFiles: ReceivedFile[];
  /** True if the service is wired and ready. */
  isReady: boolean;
  sendFile: (file: File) => Promise<string>;
  cancelTransfer: (fileId: string) => void;
  clearReceivedFile: (fileId: string) => void;
}

/** ms before a completed/failed entry disappears from the transfer list. */
const COMPLETED_LINGER_MS = 3000;

export function useFileTransfer(options: UseFileTransferOptions): UseFileTransferResult {
  const { fileTransferService, onFileReceived } = options;

  const [transfersById, setTransfersById] = useState<Record<string, TransferEntry>>({});
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);

  const onFileReceivedRef = useRef(onFileReceived);
  onFileReceivedRef.current = onFileReceived;

  // ── Wire service listeners ───────────────────────────────────────────────
  useEffect(() => {
    if (!fileTransferService) return;

    // When a remote sends FILE_META we seed an inbound transfer entry so the
    // UI can show a progress bar before any chunks arrive.
    const offIncoming = fileTransferService.onIncomingFile(({ metadata }) => {
      logger.info('[useFileTransfer] incoming file', {
        fileId: metadata.fileId,
        name: metadata.fileName,
        size: metadata.fileSize,
      });
      setTransfersById((prev) => ({
        ...prev,
        [metadata.fileId]: {
          fileId: metadata.fileId,
          bytesTransferred: 0,
          totalBytes: metadata.fileSize,
          percentage: 0,
          status: 'transferring',
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          fileType: metadata.fileType,
          direction: 'recv',
        },
      }));
    });

    const offProgress = fileTransferService.onAnyProgress((p) => {
      setTransfersById((prev) => {
        const existing = prev[p.fileId];
        const metadata = p.metadata as FileMetadata;
        return {
          ...prev,
          [p.fileId]: {
            fileId: p.fileId,
            bytesTransferred: p.bytesTransferred,
            totalBytes: p.totalBytes,
            percentage: p.percentage,
            status: p.status,
            fileName: existing?.fileName ?? metadata.fileName,
            fileSize: existing?.fileSize ?? metadata.fileSize,
            fileType: existing?.fileType ?? metadata.fileType,
            direction: existing?.direction ?? p.direction,
          },
        };
      });
    });

    const offComplete = fileTransferService.onAnyComplete(({ fileId, direction, file, metadata }) => {
      logger.info('[useFileTransfer] complete', { fileId, direction, name: metadata.fileName });
      // Inbound: surface the assembled File. Outbound: just drop the entry
      // after the linger so the user sees a brief 'completed' state.
      if (direction === 'recv' && file) {
        const objectUrl = URL.createObjectURL(file);
        const received: ReceivedFile = {
          fileId,
          file,
          receivedAt: Date.now(),
          objectUrl,
          fileType: metadata.fileType,
        };
        setReceivedFiles((prev) => [...prev, received]);
        onFileReceivedRef.current?.(received);
      }
      // Schedule entry removal from the progress list.
      setTimeout(() => {
        setTransfersById((prev) => {
          const next = { ...prev };
          delete next[fileId];
          return next;
        });
      }, COMPLETED_LINGER_MS);
    });

    return () => {
      offIncoming();
      offProgress();
      offComplete();
    };
  }, [fileTransferService]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const sendFile = useCallback(
    async (file: File): Promise<string> => {
      if (!fileTransferService) {
        throw new Error('File transfer service not ready');
      }
      logger.info('[useFileTransfer] sendFile', {
        name: file.name,
        size: file.size,
        type: file.type,
      });
      // Seed the progress entry before sendFile resolves so the UI shows the
      // transfer immediately rather than waiting for the first chunk.
      const fileId = await fileTransferService.sendFile(file, undefined, {
        onError: (id, err) => {
          logger.error('[useFileTransfer] outbound transfer failed', { id, err });
          setTransfersById((prev) => {
            const existing = prev[id];
            if (!existing) return prev;
            return { ...prev, [id]: { ...existing, status: 'failed' } };
          });
        },
      });
      // Seed (or replace) with a pre-chunk entry.
      setTransfersById((prev) => ({
        ...prev,
        [fileId]: prev[fileId] ?? {
          fileId,
          bytesTransferred: 0,
          totalBytes: file.size,
          percentage: 0,
          status: 'transferring',
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          direction: 'send',
        },
      }));
      return fileId;
    },
    [fileTransferService],
  );

  const cancelTransfer = useCallback(
    (fileId: string) => {
      fileTransferService?.cancelTransfer(fileId);
      setTransfersById((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
    },
    [fileTransferService],
  );

  const clearReceivedFile = useCallback((fileId: string) => {
    setReceivedFiles((prev) => {
      const removed = prev.find((f) => f.fileId === fileId);
      if (removed) {
        try {
          URL.revokeObjectURL(removed.objectUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((f) => f.fileId !== fileId);
    });
  }, []);

  // ── Revoke object URLs on unmount ───────────────────────────────────────
  useEffect(() => {
    return () => {
      // Snapshot at unmount time.
      setReceivedFiles((current) => {
        for (const f of current) {
          try {
            URL.revokeObjectURL(f.objectUrl);
          } catch {
            /* ignore */
          }
        }
        return [];
      });
    };
  }, []);

  return {
    transfers: Object.values(transfersById),
    receivedFiles,
    isReady: fileTransferService !== null,
    sendFile,
    cancelTransfer,
    clearReceivedFile,
  };
}
