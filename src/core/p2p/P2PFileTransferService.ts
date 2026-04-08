import type { P2PEnvelope, FileMetadata, FileTransferProgress } from '../../types';
import { P2PChannelBus } from './P2PChannelBus';
import { generateUUID } from '../../utils/uuid';
import { logger } from '../../utils/logger';

export interface FileTransferOptions {
  chunkSize?: number;
  onProgress?: (progress: FileTransferProgress) => void;
  onComplete?: (fileId: string) => void;
  onError?: (fileId: string, error: Error) => void;
}

export class P2PFileTransferService {
  private channelBus: P2PChannelBus;
  private localUid: string;
  private deviceId: string;
  private chunkSize: number;
  private activeTransfers: Map<string, FileTransferState> = new Map();
  private progressCallbacks: Map<string, FileTransferOptions> = new Map();

  constructor(channelBus: P2PChannelBus, localUid: string, deviceId: string, chunkSize = 64 * 1024) {
    this.channelBus = channelBus;
    this.localUid = localUid;
    this.deviceId = deviceId;
    this.chunkSize = chunkSize;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.channelBus.subscribe('file', async (envelope) => {
      await this.handleFileMessage(envelope);
    });
  }

  async sendFile(file: File, to?: string, options?: FileTransferOptions): Promise<string> {
    const fileId = generateUUID();
    const chunkCount = Math.ceil(file.size / this.chunkSize);

    const metadata: FileMetadata = {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      chunkCount,
      chunkSize: this.chunkSize,
    };

    const state: FileTransferState = {
      fileId,
      file,
      metadata,
      to,
      chunkIndex: 0,
      status: 'pending',
      bytesTransferred: 0,
    };

    this.activeTransfers.set(fileId, state);
    if (options) {
      this.progressCallbacks.set(fileId, options);
    }

    // 發送檔案 metadata
    const metaEnvelope: P2PEnvelope = {
      v: 1,
      ns: 'file',
      type: 'FILE_META',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      to,
      payload: metadata,
    };

    await this.channelBus.send(metaEnvelope);
    state.status = 'transferring';

    // 開始傳送 chunks
    this.sendChunks(fileId);

    return fileId;
  }

  private async sendChunks(fileId: string): Promise<void> {
    const state = this.activeTransfers.get(fileId);
    if (!state || !state.file) return;

    const { file, metadata, chunkIndex } = state;

    for (let i = chunkIndex; i < metadata.chunkCount; i++) {
      // 重新獲取狀態，因為可能在循環中改變
      const currentState = this.activeTransfers.get(fileId);
      if (!currentState) return;
      
      if (currentState.status === 'cancelled') {
        await this.sendCancel(fileId);
        return;
      }
      if (currentState.status !== 'transferring') {
        return;
      }

      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, file.size);
      const chunk = file.slice(start, end);

      const arrayBuffer = await chunk.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

      const chunkEnvelope: P2PEnvelope = {
        v: 1,
        ns: 'file',
        type: 'FILE_CHUNK',
        id: generateUUID(),
        ts: Date.now(),
        from: `${this.localUid}/${this.deviceId}`,
        to: state.to,
        payload: {
          fileId,
          chunkIndex: i,
          data: base64,
        },
      };

      await this.channelBus.send(chunkEnvelope);
      state.chunkIndex = i + 1;
      state.bytesTransferred = end;

      this.updateProgress(fileId);

      // 避免阻塞，讓出控制權
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // 發送結束標記
    const endEnvelope: P2PEnvelope = {
      v: 1,
      ns: 'file',
      type: 'FILE_END',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      to: state.to,
      payload: { fileId },
    };

    await this.channelBus.send(endEnvelope);
    state.status = 'completed';
    this.updateProgress(fileId);

    const callbacks = this.progressCallbacks.get(fileId);
    if (callbacks?.onComplete) {
      callbacks.onComplete(fileId);
    }
  }

  private async handleFileMessage(envelope: P2PEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'FILE_META':
        await this.handleFileMeta(envelope);
        break;
      case 'FILE_CHUNK':
        await this.handleFileChunk(envelope);
        break;
      case 'FILE_END':
        await this.handleFileEnd(envelope);
        break;
      case 'FILE_CANCEL':
        await this.handleFileCancel(envelope);
        break;
    }
  }

  private async handleFileMeta(envelope: P2PEnvelope): Promise<void> {
    const metadata = envelope.payload as FileMetadata;
    const state: FileTransferState = {
      fileId: metadata.fileId,
      file: null,
      metadata,
      to: envelope.from,
      chunkIndex: 0,
      status: 'pending',
      bytesTransferred: 0,
      chunks: new Map(),
    };

    this.activeTransfers.set(metadata.fileId, state);
  }

  private async handleFileChunk(envelope: P2PEnvelope): Promise<void> {
    const { fileId, chunkIndex, data } = envelope.payload as {
      fileId: string;
      chunkIndex: number;
      data: string;
    };

    const state = this.activeTransfers.get(fileId);
    if (!state) return;

    if (!state.chunks) {
      state.chunks = new Map();
    }

    // 解碼 base64
    let binaryString: string;
    try {
      binaryString = atob(data);
    } catch {
      throw new Error('Invalid base64 input');
    }
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    state.chunks.set(chunkIndex, bytes);
    state.bytesTransferred += bytes.length;

    this.updateProgress(fileId);
  }

  private async handleFileEnd(envelope: P2PEnvelope): Promise<void> {
    const { fileId } = envelope.payload as { fileId: string };
    const state = this.activeTransfers.get(fileId);
    if (!state || !state.chunks) return;

    // 重組檔案
    const chunks: BlobPart[] = [];
    for (let i = 0; i < state.metadata.chunkCount; i++) {
      const chunk = state.chunks.get(i);
      if (!chunk) {
        logger.error(`[P2PFileTransferService] Missing chunk ${i} for file ${fileId}`);
        state.status = 'failed';
        const callbacks = this.progressCallbacks.get(fileId);
        if (callbacks?.onError) {
          callbacks.onError(fileId, new Error(`Missing chunk ${i}`));
        }
        return;
      }
      // 直接使用 Uint8Array，Blob 可以接受
      chunks.push(new Uint8Array(chunk));
    }

    const blob = new Blob(chunks, { type: state.metadata.fileType });
    const file = new File([blob], state.metadata.fileName, { type: state.metadata.fileType });

    state.file = file;
    state.status = 'completed';
    this.updateProgress(fileId);

    const callbacks = this.progressCallbacks.get(fileId);
    if (callbacks?.onComplete) {
      callbacks.onComplete(fileId);
    }
  }

  private async handleFileCancel(envelope: P2PEnvelope): Promise<void> {
    const { fileId } = envelope.payload as { fileId: string };
    const state = this.activeTransfers.get(fileId);
    if (state) {
      state.status = 'cancelled';
    }
  }

  private async sendCancel(fileId: string): Promise<void> {
    const state = this.activeTransfers.get(fileId);
    if (!state) return;

    const cancelEnvelope: P2PEnvelope = {
      v: 1,
      ns: 'file',
      type: 'FILE_CANCEL',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      to: state.to,
      payload: { fileId },
    };

    await this.channelBus.send(cancelEnvelope);
  }

  cancelTransfer(fileId: string): void {
    const state = this.activeTransfers.get(fileId);
    if (state && state.status === 'transferring') {
      state.status = 'cancelled';
      this.sendCancel(fileId);
    }
  }

  getFile(fileId: string): File | null {
    const state = this.activeTransfers.get(fileId);
    return state?.file || null;
  }

  getProgress(fileId: string): FileTransferProgress | null {
    const state = this.activeTransfers.get(fileId);
    if (!state) return null;

    return {
      fileId,
      bytesTransferred: state.bytesTransferred,
      totalBytes: state.metadata.fileSize,
      percentage: (state.bytesTransferred / state.metadata.fileSize) * 100,
      status: state.status,
    };
  }

  private updateProgress(fileId: string): void {
    const progress = this.getProgress(fileId);
    if (progress) {
      const callbacks = this.progressCallbacks.get(fileId);
      if (callbacks?.onProgress) {
        callbacks.onProgress(progress);
      }
    }
  }

  cleanup(fileId: string): void {
    this.activeTransfers.delete(fileId);
    this.progressCallbacks.delete(fileId);
  }
}

interface FileTransferState {
  fileId: string;
  file: File | null;
  metadata: FileMetadata;
  to?: string;
  chunkIndex: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
  bytesTransferred: number;
  chunks?: Map<number, Uint8Array>;
}



