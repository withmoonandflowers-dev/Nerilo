import type { FeatureModule, FeatureContext, Envelope } from '../../../types';

export interface FileMetaPayload {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  chunkCount: number;
  chunkSize: number;
  fromPeerId: string;
}

export interface FileChunkPayload {
  fileId: string;
  chunkIndex: number;
  data: string; // base64 encoded chunk
  totalChunks: number;
}

export interface FileEndPayload {
  fileId: string;
  checksum?: string;
}

export interface FileAckPayload {
  fileId: string;
  receivedBy: string;
}

export interface FileCancelPayload {
  fileId: string;
  cancelledBy: string;
  reason?: string;
}

type FileCompleteCallback = (fileId: string, chunks: string[]) => void;

let _ctx: FeatureContext | null = null;

// In-flight chunk buffers: fileId -> array of chunks indexed by chunkIndex
const chunkBuffers = new Map<string, (string | undefined)[]>();
const metaMap = new Map<string, FileMetaPayload>();
const completeCallbacks: FileCompleteCallback[] = [];

export const FileFeature: FeatureModule = {
  name: 'file',
  version: '1.0.0',
  namespaces: ['file'],
  capabilities: ['file:send', 'file:receive', 'file:resume', 'file:cancel'],

  async setup(ctx: FeatureContext): Promise<void> {
    _ctx = ctx;
    ctx.logger.info('[FileFeature] setup complete', { selfId: ctx.selfId, roomId: ctx.roomId });
  },

  async teardown(): Promise<void> {
    _ctx = null;
    chunkBuffers.clear();
    metaMap.clear();
    completeCallbacks.length = 0;
  },

  async onPeerJoin(peerId: string): Promise<void> {
    _ctx?.logger.info('[FileFeature] peer joined', { peerId });
  },

  async onPeerLeave(peerId: string): Promise<void> {
    _ctx?.logger.info('[FileFeature] peer left', { peerId });
    // Cancel any in-flight transfers from this peer
    for (const [fileId, meta] of metaMap.entries()) {
      if (meta.fromPeerId === peerId) {
        chunkBuffers.delete(fileId);
        metaMap.delete(fileId);
        _ctx?.logger.warn('[FileFeature] cancelled transfer due to peer leaving', { fileId, peerId });
      }
    }
  },

  async handleEnvelope(env: Envelope): Promise<void> {
    if (!_ctx) return;

    switch (env.type) {
      case 'file:FILE_META': {
        const payload = env.payload as FileMetaPayload;
        metaMap.set(payload.fileId, payload);
        chunkBuffers.set(payload.fileId, new Array(payload.chunkCount));
        await _ctx.appendLedger('file:meta', payload);
        _ctx.logger.info('[FileFeature] received file meta', {
          fileId: payload.fileId,
          fileName: payload.fileName,
          fileSize: payload.fileSize,
        });
        break;
      }

      case 'file:FILE_CHUNK': {
        const payload = env.payload as FileChunkPayload;
        const buffer = chunkBuffers.get(payload.fileId);
        if (buffer) {
          buffer[payload.chunkIndex] = payload.data;
          _ctx.logger.info('[FileFeature] received chunk', {
            fileId: payload.fileId,
            chunkIndex: payload.chunkIndex,
            totalChunks: payload.totalChunks,
          });
        }
        break;
      }

      case 'file:FILE_END': {
        const payload = env.payload as FileEndPayload;
        const buffer = chunkBuffers.get(payload.fileId);
        const meta = metaMap.get(payload.fileId);

        if (buffer && meta) {
          // Reassemble: filter out undefined chunks
          const chunks = buffer.filter((c): c is string => c !== undefined);
          _ctx.logger.info('[FileFeature] file transfer complete', {
            fileId: payload.fileId,
            receivedChunks: chunks.length,
            expectedChunks: meta.chunkCount,
          });

          // Emit complete event
          for (const cb of completeCallbacks) {
            cb(payload.fileId, chunks);
          }

          // Clean up buffers
          chunkBuffers.delete(payload.fileId);
          metaMap.delete(payload.fileId);
        }
        break;
      }

      case 'file:FILE_ACK': {
        const payload = env.payload as FileAckPayload;
        _ctx.logger.info('[FileFeature] file acknowledged', {
          fileId: payload.fileId,
          receivedBy: payload.receivedBy,
        });
        break;
      }

      case 'file:FILE_CANCEL': {
        const payload = env.payload as FileCancelPayload;
        chunkBuffers.delete(payload.fileId);
        metaMap.delete(payload.fileId);
        _ctx.logger.warn('[FileFeature] file transfer cancelled', {
          fileId: payload.fileId,
          cancelledBy: payload.cancelledBy,
          reason: payload.reason,
        });
        break;
      }

      default:
        // Unknown type - ignore gracefully
        break;
    }
  },
};
