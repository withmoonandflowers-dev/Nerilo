import type { RawSignalDoc, SignalingTransport } from './SignalingTransport.types';

/**
 * 純記憶體 signaling（無 Firebase），證明 SignalingTransport 這道注入縫是真的可替換
 * （P2）。語義刻意鏡像 RoomSignalingTransport：以 roomId 為單位共用一份 signals（同一房
 * 所有 channelLabel 混在一起，channelLabel 過濾由 manager 負責）；subscribe 先回放 cutoff
 * 之後的既有、再串新增（對齊 Firestore onSnapshot 首次帶齊 + docChanges 'added'）。
 *
 * 同一顆 Hub 給多個 peer 共用即可在單一行程內互通，也是自架 WebSocket 後端的參考形狀
 * （把 publish/subscribe 換成 ws 收送即可）。
 */
interface StoredDoc {
  doc: RawSignalDoc;
  createdAtMs: number;
}

export class InMemorySignalingHub {
  private byRoom = new Map<string, StoredDoc[]>();
  private subs = new Map<string, Set<(d: RawSignalDoc) => void>>();
  private seq = 0;

  publish(roomId: string, data: Record<string, unknown>): void {
    const createdAtMs = typeof data.createdAt === 'number' ? (data.createdAt as number) : Date.now();
    const doc = { ...data, signalId: `sig-${++this.seq}` } as RawSignalDoc;
    const list = this.byRoom.get(roomId) ?? [];
    list.push({ doc, createdAtMs });
    this.byRoom.set(roomId, list);
    this.subs.get(roomId)?.forEach((cb) => cb(doc));
  }

  subscribe(roomId: string, cutoffMs: number, onAdded: (d: RawSignalDoc) => void): () => void {
    // 回放 cutoff 之後的既有（鏡像 onSnapshot 首次快照）
    for (const s of this.byRoom.get(roomId) ?? []) {
      if (s.createdAtMs >= cutoffMs) onAdded(s.doc);
    }
    const set = this.subs.get(roomId) ?? new Set<(d: RawSignalDoc) => void>();
    set.add(onAdded);
    this.subs.set(roomId, set);
    return () => { set.delete(onAdded); };
  }

  removeOlderThan(roomId: string, beforeMs: number, channelLabel: string): void {
    const list = this.byRoom.get(roomId);
    if (!list) return;
    this.byRoom.set(
      roomId,
      list.filter((s) => !(s.createdAtMs < beforeMs && s.doc.channelLabel === channelLabel))
    );
  }

  removeOwn(roomId: string, from: string, channelLabel: string): void {
    const list = this.byRoom.get(roomId);
    if (!list) return;
    this.byRoom.set(
      roomId,
      list.filter((s) => !(s.doc.from === from && s.doc.channelLabel === channelLabel))
    );
  }
}

export class InMemorySignalingTransport implements SignalingTransport {
  constructor(
    private readonly hub: InMemorySignalingHub,
    private readonly roomId: string,
    private readonly channelLabel: string
  ) {}

  subscribe(cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void {
    return this.hub.subscribe(this.roomId, cutoffMs, onAdded);
  }

  async send(data: Record<string, unknown>): Promise<void> {
    this.hub.publish(this.roomId, data);
  }

  async cleanupOlderThan(beforeMs: number): Promise<void> {
    this.hub.removeOlderThan(this.roomId, beforeMs, this.channelLabel);
  }

  async cleanupOwn(localUid: string): Promise<void> {
    this.hub.removeOwn(this.roomId, localUid, this.channelLabel);
  }
}
