import type { P2PEnvelope } from '../../types';

export interface ChannelMessage {
  envelope: P2PEnvelope;
  raw: string;
}

export type MessageHandler = (envelope: P2PEnvelope) => void | Promise<void>;

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
      console.warn('[P2PChannelBus] setupDataChannel: DataChannel is null');
      return;
    }

    console.log('[P2PChannelBus] setupDataChannel', {
      label: this.dataChannel.label,
      readyState: this.dataChannel.readyState,
    });

    this.dataChannel.onmessage = (event) => {
      try {
        console.log('[P2PChannelBus] onmessage received', {
          dataLength: event.data?.length || 0,
          readyState: this.dataChannel?.readyState,
        });
        const envelope = JSON.parse(event.data) as P2PEnvelope;
        console.log('[P2PChannelBus] Message parsed', {
          envelopeId: envelope.id,
          ns: envelope.ns,
          type: envelope.type,
          from: envelope.from,
        });
        this.handleMessage(envelope);
      } catch (error) {
        console.error('[P2PChannelBus] Error parsing message', {
          error,
          data: event.data,
        });
        this.emitError('system', 'PARSE_ERROR', 'Failed to parse message');
      }
    };

    this.dataChannel.onerror = (error) => {
      console.error('[P2PChannelBus] DataChannel error', {
        error,
        readyState: this.dataChannel?.readyState,
      });
      this.emitError('system', 'CHANNEL_ERROR', 'DataChannel error occurred');
    };

    this.dataChannel.onclose = () => {
      console.log('[P2PChannelBus] DataChannel closed', {
        label: this.dataChannel?.label,
      });
    };

    this.dataChannel.onopen = () => {
      console.log('[P2PChannelBus] DataChannel opened', {
        label: this.dataChannel?.label,
        readyState: this.dataChannel?.readyState,
      });
      this.processQueue();
    };

    // 設定緩衝區低水位標記
    this.dataChannel.bufferedAmountLowThreshold = this.bufferedAmountLowThreshold;
    this.dataChannel.onbufferedamountlow = () => {
      console.log('[P2PChannelBus] Buffered amount low', {
        bufferedAmount: this.dataChannel?.bufferedAmount,
      });
      this.processQueue();
    };
  }

  private async handleMessage(envelope: P2PEnvelope): Promise<void> {
    console.log('[P2PChannelBus] handleMessage called', {
      envelopeId: envelope.id,
      ns: envelope.ns,
      type: envelope.type,
      from: envelope.from,
    });

    // 驗證基本欄位
    if (!this.validateEnvelope(envelope)) {
      console.error('[P2PChannelBus] Invalid envelope', {
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

    console.log('[P2PChannelBus] Dispatching to handlers', {
      envelopeId: envelope.id,
      ns: envelope.ns,
      handlerCount: allHandlersToCall.size,
      specificHandlers: handlers.size,
      wildcardHandlers: allHandlers.size,
    });

    for (const handler of allHandlersToCall) {
      try {
        await handler(envelope);
        console.log('[P2PChannelBus] Handler executed successfully', {
          envelopeId: envelope.id,
          ns: envelope.ns,
          type: envelope.type,
        });
      } catch (error) {
        console.error('[P2PChannelBus] Error in handler', {
          envelopeId: envelope.id,
          ns: envelope.ns,
          type: envelope.type,
          error,
        });
      }
    }
  }

  private validateEnvelope(envelope: P2PEnvelope): boolean {
    return !!(
      envelope.v &&
      envelope.ns &&
      envelope.type &&
      envelope.id &&
      envelope.ts &&
      envelope.from &&
      envelope.payload !== undefined
    );
  }

  send(envelope: P2PEnvelope): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[P2PChannelBus] send called', {
        envelopeId: envelope.id,
        ns: envelope.ns,
        type: envelope.type,
        hasDataChannel: !!this.dataChannel,
        readyState: this.dataChannel?.readyState,
      });

      if (!this.dataChannel) {
        console.error('[P2PChannelBus] send failed: DataChannel not available', {
          envelopeId: envelope.id,
        });
        reject(new Error('DataChannel not available'));
        return;
      }

      if (this.dataChannel.readyState !== 'open') {
        console.warn('[P2PChannelBus] send: DataChannel not open, queuing message', {
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
          console.log('[P2PChannelBus] Message queued (buffer full)', {
            envelopeId: envelope.id,
            queueLength: this.sendQueue.length,
            bufferedAmount: this.dataChannel.bufferedAmount,
            threshold: this.bufferedAmountLowThreshold,
          });
          resolve();
        } else {
          this.dataChannel.send(message);
          console.log('[P2PChannelBus] Message sent immediately', {
            envelopeId: envelope.id,
            messageLength: message.length,
            bufferedAmount: this.dataChannel.bufferedAmount,
          });
          resolve();
        }
      } catch (error) {
        console.error('[P2PChannelBus] Error sending message', {
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
          console.error('Error sending queued message:', error);
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



