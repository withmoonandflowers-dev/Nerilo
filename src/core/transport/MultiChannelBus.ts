import type { ChannelKind } from '../../types';

const HIGH_WATERMARK: Record<ChannelKind, number> = {
  bulk: 16 * 1024 * 1024,  // 16 MB
  control: 256 * 1024,      // 256 KB
  gossip: 256 * 1024,       // 256 KB
};

const LOW_WATERMARK: Record<ChannelKind, number> = {
  bulk: HIGH_WATERMARK.bulk / 2,
  control: HIGH_WATERMARK.control / 2,
  gossip: HIGH_WATERMARK.gossip / 2,
};

type MessageHandler = (peerId: string, kind: ChannelKind, data: string | ArrayBuffer) => void;

export class MultiChannelBus {
  private channels = new Map<string, Map<ChannelKind, RTCDataChannel>>();
  private paused = new Set<string>();
  private messageHandlers: MessageHandler[] = [];

  register(peerId: string, kind: ChannelKind, channel: RTCDataChannel): void {
    if (!this.channels.has(peerId)) {
      this.channels.set(peerId, new Map());
    }
    const peerChannels = this.channels.get(peerId)!;
    peerChannels.set(kind, channel);
    this.setupBackpressure(peerId, channel, kind);
    channel.onmessage = (event: MessageEvent) => {
      for (const handler of this.messageHandlers) {
        handler(peerId, kind, event.data as string | ArrayBuffer);
      }
    };
  }

  unregister(peerId: string): void {
    const peerChannels = this.channels.get(peerId);
    if (peerChannels) {
      for (const channel of peerChannels.values()) {
        channel.onmessage = null;
        channel.onbufferedamountlow = null;
      }
    }
    this.channels.delete(peerId);
    this.paused.delete(peerId);
  }

  send(peerId: string, kind: ChannelKind, data: string | ArrayBuffer): void {
    if (this.paused.has(peerId)) {
      console.warn(
        `[MultiChannelBus] Peer ${peerId} is paused due to backpressure, dropping ${kind} message`
      );
      return;
    }
    const peerChannels = this.channels.get(peerId);
    if (!peerChannels) {
      throw new Error(`[MultiChannelBus] No channels registered for peer ${peerId}`);
    }
    const channel = peerChannels.get(kind);
    if (!channel) {
      throw new Error(
        `[MultiChannelBus] No ${kind} channel registered for peer ${peerId}`
      );
    }
    if (channel.readyState !== 'open') {
      console.warn(
        `[MultiChannelBus] Channel ${kind} for peer ${peerId} is not open (state: ${channel.readyState})`
      );
      return;
    }

    channel.send(data as string);

    // Check backpressure AFTER sending
    if (channel.bufferedAmount > HIGH_WATERMARK[kind]) {
      this.paused.add(peerId);
      console.warn(
        `[MultiChannelBus] Backpressure: pausing peer ${peerId} on ${kind} channel (buffered: ${channel.bufferedAmount})`
      );
    }
  }

  broadcast(kind: ChannelKind, data: string | ArrayBuffer, exclude?: string): void {
    for (const peerId of this.channels.keys()) {
      if (exclude && peerId === exclude) continue;
      try {
        this.send(peerId, kind, data);
      } catch {
        console.warn(`[MultiChannelBus] Failed to broadcast to peer ${peerId}`);
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  getChannel(peerId: string, kind: ChannelKind): RTCDataChannel | undefined {
    return this.channels.get(peerId)?.get(kind);
  }

  isConnected(peerId: string): boolean {
    const peerChannels = this.channels.get(peerId);
    if (!peerChannels || peerChannels.size === 0) return false;
    for (const channel of peerChannels.values()) {
      if (channel.readyState !== 'open') return false;
    }
    return true;
  }

  connectedPeers(): string[] {
    return Array.from(this.channels.keys()).filter((peerId) => this.isConnected(peerId));
  }

  private setupBackpressure(peerId: string, channel: RTCDataChannel, _kind: ChannelKind): void {
    const lwm = LOW_WATERMARK[_kind];
    channel.bufferedAmountLowThreshold = lwm;

    channel.onbufferedamountlow = () => {
      if (this.paused.has(peerId)) {
        this.paused.delete(peerId);
      }
    };
  }
}
