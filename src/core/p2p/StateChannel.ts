/**
 * StateChannel — 不可靠二進位狀態幀通道（ADR-0019）
 *
 * 刻意「不」走 P2PChannelBus：那條做 JSON envelope 驗證，60Hz 狀態幀過它是浪費，
 * 且狀態幀是 binary（ADR-0018 codec）不是 envelope。本通道直接收送 Uint8Array。
 *
 * 語義（配 ordered:false, maxRetransmits:0 的 DataChannel）：
 * - send：通道未 open 就丟棄（lossy，下一幀天然覆蓋，不排隊）。
 * - 收端只吐 binary frame；非 binary 一律忽略（防雜訊）。
 * - 收端的 stale 幀丟棄由上層 StateFrameCodec 的 FrameGate 負責，本層不管序。
 */

export type StateFrameHandler = (frame: Uint8Array) => void;

export class StateChannel {
  private frameHandlers = new Set<StateFrameHandler>();

  constructor(private readonly channel: RTCDataChannel) {
    // 確保以 ArrayBuffer 形式收 binary（而非 Blob）
    try {
      this.channel.binaryType = 'arraybuffer';
    } catch {
      /* 某些環境唯讀；忽略 */
    }
    this.channel.onmessage = (event: MessageEvent) => {
      const bytes = toBytes(event.data);
      if (!bytes) return; // 非 binary → 忽略
      for (const h of this.frameHandlers) {
        try {
          h(bytes);
        } catch {
          /* handler 自己的錯不影響其他 handler */
        }
      }
    };
  }

  /** 送一幀。通道未 open 即丟棄（回 false）——lossy 通道不排隊。 */
  send(frame: Uint8Array): boolean {
    if (this.channel.readyState !== 'open') return false;
    try {
      // RTCDataChannel.send 接受 ArrayBufferView；TS lib 對 Uint8Array 可能為
      // SharedArrayBuffer-backed 過嚴，runtime 無此問題，明確轉型。
      this.channel.send(frame as unknown as ArrayBuffer);
      return true;
    } catch {
      return false;
    }
  }

  /** 訂閱收到的幀。回傳取消訂閱函式。 */
  onFrame(handler: StateFrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  getReadyState(): RTCDataChannelState {
    return this.channel.readyState;
  }

  close(): void {
    this.frameHandlers.clear();
    try {
      this.channel.close();
    } catch {
      /* noop */
    }
  }
}

/** 把 DataChannel message data 轉成 Uint8Array（僅接受 binary） */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
