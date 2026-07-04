import type { P2PEnvelope } from '../../types';
import { logger } from '../../utils/logger';

export interface ChannelMessage {
  envelope: P2PEnvelope;
  raw: string;
}

export type MessageHandler = (envelope: P2PEnvelope) => void | Promise<void>;

/**
 * Maximum size (bytes) of an inbound DataChannel message. Anything larger is
 * dropped before JSON.parse to prevent a malicious peer from OOM'ing the tab
 * by sending a giant blob. Legitimate envelopes are well under 64 KB — the
 * 256 KB ceiling leaves room for envelope-wrapped Sphinx packets + chunked
 * file transfers without admitting trivial DoS.
 */
const MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;

export class P2PChannelBus {
  private dataChannel: RTCDataChannel | null = null;
  private messageHandlers: Map<string, Set<MessageHandler>> = new Map();
  private bufferedAmountLowThreshold = 64 * 1024; // 64KB
  private sendQueue: string[] = [];
  private isProcessingQueue = false;

  constructor(dataChannel: RTCDataChannel) {
    this.dataChannel = dataChannel;
    this.setupDataChannel();
  }

  private setupDataChannel(): void {
    if (!this.dataChannel) {
      logger.warn('[P2PChannelBus] setupDataChannel: DataChannel is null');
      return;
    }

    logger.info('[P2PChannelBus] setupDataChannel', {
      label: this.dataChannel.label,
      readyState: this.dataChannel.readyState,
    });

    this.dataChannel.onmessage = (event) => {
      try {
        // DoS guard: drop oversized inbound frames before JSON.parse can OOM
        // the tab. byteLength for ArrayBuffer/Blob, length for string.
        const data: unknown = event.data;
        const size =
          typeof data === 'string'
            ? data.length
            : data instanceof ArrayBuffer
              ? data.byteLength
              : (data as { size?: number; byteLength?: number })?.size ??
                (data as { byteLength?: number })?.byteLength ??
                0;
        if (size > MAX_INBOUND_MESSAGE_BYTES) {
          logger.warn('[P2PChannelBus] Dropped oversized DataChannel message', {
            size,
            limit: MAX_INBOUND_MESSAGE_BYTES,
          });
          this.emitError('system', 'OVERSIZED_MESSAGE', `Message exceeds ${MAX_INBOUND_MESSAGE_BYTES} bytes`);
          return;
        }

        logger.info('[P2PChannelBus] onmessage received', {
          dataLength: size,
          readyState: this.dataChannel?.readyState,
        });
        const envelope = JSON.parse(event.data) as P2PEnvelope;
        logger.info('[P2PChannelBus] Message parsed', {
          envelopeId: envelope.id,
          ns: envelope.ns,
          type: envelope.type,
          from: envelope.from,
        });
        this.handleMessage(envelope);
      } catch (error) {
        logger.error('[P2PChannelBus] Error parsing message', {
          error,
          data: event.data,
        });
        this.emitError('system', 'PARSE_ERROR', 'Failed to parse message');
      }
    };

    this.dataChannel.onerror = (error) => {
      logger.error('[P2PChannelBus] DataChannel error', {
        error,
        readyState: this.dataChannel?.readyState,
      });
      this.emitError('system', 'CHANNEL_ERROR', 'DataChannel error occurred');
    };

    this.dataChannel.onclose = () => {
      logger.info('[P2PChannelBus] DataChannel closed', {
        label: this.dataChannel?.label,
      });
    };

    this.dataChannel.onopen = () => {
      logger.info('[P2PChannelBus] DataChannel opened', {
        label: this.dataChannel?.label,
        readyState: this.dataChannel?.readyState,
      });
      this.processQueue();
    };

    // 設定緩衝區低水位標記
    this.dataChannel.bufferedAmountLowThreshold = this.bufferedAmountLowThreshold;
    this.dataChannel.onbufferedamountlow = () => {
      logger.info('[P2PChannelBus] Buffered amount low', {
        bufferedAmount: this.dataChannel?.bufferedAmount,
      });
      this.processQueue();
    };
  }

  private async handleMessage(envelope: P2PEnvelope): Promise<void> {
    logger.info('[P2PChannelBus] handleMessage called', {
      envelopeId: envelope.id,
      ns: envelope.ns,
      type: envelope.type,
      from: envelope.from,
    });

    // 驗證基本欄位
    if (!this.validateEnvelope(envelope)) {
      logger.error('[P2PChannelBus] Invalid envelope', {
        envelopeId: envelope.id,
        envelope,
      });
      this.emitError(envelope.ns, 'INVALID_ENVELOPE', 'Envelope validation failed');
      return;
    }

    // 分派給對應的 handler
    const handlers = this.messageHandlers.get(envelope.ns) || new Set();
    const allHandlers = this.messageHandlers.get('*') || new Set();

    const allHandlersToCall = new Set([...handlers, ...allHandlers]);

    logger.info('[P2PChannelBus] Dispatching to handlers', {
      envelopeId: envelope.id,
      ns: envelope.ns,
      handlerCount: allHandlersToCall.size,
      specificHandlers: handlers.size,
      wildcardHandlers: allHandlers.size,
    });

    for (const handler of allHandlersToCall) {
      try {
        await handler(envelope);
        logger.info('[P2PChannelBus] Handler executed successfully', {
          envelopeId: envelope.id,
          ns: envelope.ns,
          type: envelope.type,
        });
      } catch (error) {
        logger.error('[P2PChannelBus] Error in handler', {
          envelopeId: envelope.id,
          ns: envelope.ns,
          type: envelope.type,
          error,
        });
      }
    }
  }

  /**
   * 嚴格驗證 envelope 結構（來源是不可信的遠端 peer）。
   *
   * 不只檢查「存在」，還檢查「型別正確」——惡意 peer 可送 ns=物件、from=數字
   * 等畸形值，下游對這些欄位做字串操作（extractUid 等）會誤動作或擲錯。
   * 額外擋掉會污染原型鏈的保留字當作 namespace（縱深防禦；Map 分派本身安全，
   * 但避免任何下游用 ns 索引普通物件）。
   */
  private validateEnvelope(envelope: P2PEnvelope): boolean {
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (
      !isNum(envelope.v) ||
      !isStr(envelope.ns) ||
      !isStr(envelope.type) ||
      !isStr(envelope.id) ||
      !isNum(envelope.ts) ||
      !isStr(envelope.from) ||
      envelope.payload === undefined
    ) {
      return false;
    }
    // 原型污染縱深防禦：ns/type 不得為保留字
    const dangerous = ['__proto__', 'constructor', 'prototype'];
    if (dangerous.includes(envelope.ns) || dangerous.includes(envelope.type)) {
      return false;
    }
    return true;
  }

  send(envelope: P2PEnvelope): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info('[P2PChannelBus] send called', {
        envelopeId: envelope.id,
        ns: envelope.ns,
        type: envelope.type,
        hasDataChannel: !!this.dataChannel,
        readyState: this.dataChannel?.readyState,
      });

      if (!this.dataChannel) {
        logger.error('[P2PChannelBus] send failed: DataChannel not available', {
          envelopeId: envelope.id,
        });
        reject(new Error('DataChannel not available'));
        return;
      }

      if (this.dataChannel.readyState !== 'open') {
        logger.warn('[P2PChannelBus] send: DataChannel not open, queuing message', {
          envelopeId: envelope.id,
          readyState: this.dataChannel.readyState,
          queueLength: this.sendQueue.length,
        });
        // 加入佇列
        this.sendQueue.push(JSON.stringify(envelope));
        resolve();
        return;
      }

      try {
        const message = JSON.stringify(envelope);
        
        if (this.dataChannel.bufferedAmount > this.bufferedAmountLowThreshold) {
          // 緩衝區已滿，加入佇列
          this.sendQueue.push(message);
          logger.info('[P2PChannelBus] Message queued (buffer full)', {
            envelopeId: envelope.id,
            queueLength: this.sendQueue.length,
            bufferedAmount: this.dataChannel.bufferedAmount,
            threshold: this.bufferedAmountLowThreshold,
          });
          resolve();
        } else {
          this.dataChannel.send(message);
          logger.info('[P2PChannelBus] Message sent immediately', {
            envelopeId: envelope.id,
            messageLength: message.length,
            bufferedAmount: this.dataChannel.bufferedAmount,
          });
          resolve();
        }
      } catch (error) {
        logger.error('[P2PChannelBus] Error sending message', {
          envelopeId: envelope.id,
          error,
        });
        reject(error);
      }
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || !this.dataChannel) return;
    if (this.dataChannel.readyState !== 'open') return;
    if (this.sendQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.sendQueue.length > 0 && this.dataChannel.bufferedAmount < this.bufferedAmountLowThreshold) {
      const message = this.sendQueue.shift();
      if (message) {
        try {
          this.dataChannel.send(message);
        } catch (error) {
          logger.error('Error sending queued message:', error);
          // 重新加入佇列前端
          this.sendQueue.unshift(message);
          break;
        }
      }
    }

    this.isProcessingQueue = false;
  }

  subscribe(namespace: string, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(namespace)) {
      this.messageHandlers.set(namespace, new Set());
    }
    this.messageHandlers.get(namespace)!.add(handler);

    // 返回取消訂閱函數
    return () => {
      const handlers = this.messageHandlers.get(namespace);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.messageHandlers.delete(namespace);
        }
      }
    };
  }

  private emitError(namespace: string, type: string, message: string): void {
    const errorEnvelope: P2PEnvelope = {
      v: 1,
      ns: 'system',
      type: 'ERROR',
      id: `error_${Date.now()}`,
      ts: Date.now(),
      from: 'system',
      payload: {
        namespace,
        type,
        message,
      },
    };

    this.handleMessage(errorEnvelope);
  }

  getBufferedAmount(): number {
    return this.dataChannel?.bufferedAmount || 0;
  }

  getReadyState(): RTCDataChannelState {
    return this.dataChannel?.readyState || 'closed';
  }

  close(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.messageHandlers.clear();
    this.sendQueue = [];
  }
}



