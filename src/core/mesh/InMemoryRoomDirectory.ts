import type { IRoomDirectory, RoomSnapshot, DirectoryIdentity } from '../../ports/IRoomDirectory';

/**
 * 純記憶體名冊（無 Firebase），證明 IRoomDirectory 這道發現縫可脫離 Firestore（P2b）。
 * 同一顆 Hub 給多個 peer 共用即可在單一行程內互相發現；registerIdentity 每次 bump
 * joinedAt（鏡像 Firestore 的 rejoin 語義，讓「離開再進」偵測在記憶體下也成立）。
 * 也是自架後端的參考形狀（把 publish/watch 換成你的推送通道即可）。
 */
export class InMemoryRoomDirectoryHub {
  private rooms = new Map<string, RoomSnapshot>();
  private watchers = new Map<string, Set<(s: RoomSnapshot) => void>>();

  private room(roomId: string): RoomSnapshot {
    let r = this.rooms.get(roomId);
    if (!r) { r = { meshIdentities: {}, participants: [] }; this.rooms.set(roomId, r); }
    return r;
  }

  /** 目前狀態的淺快照（meshIdentities 複製一份，避免呼叫端看到後續突變）。 */
  snapshot(roomId: string): RoomSnapshot {
    const r = this.room(roomId);
    return { meshIdentities: { ...r.meshIdentities }, participants: [...r.participants] };
  }

  register(
    roomId: string,
    uid: string,
    entry: { userId: string; pubKey: string; ecdhPubKey?: string; introducedBy?: string }
  ): void {
    const r = this.room(roomId);
    const identity: DirectoryIdentity = { ...entry, joinedAt: Date.now() }; // 每次 bump → rejoin 可偵測
    r.meshIdentities[uid] = identity;
    if (!r.participants.includes(uid)) r.participants.push(uid);
    this.notify(roomId);
  }

  watch(roomId: string, onChange: (s: RoomSnapshot) => void): () => void {
    onChange(this.snapshot(roomId)); // 首次立即帶目前狀態（鏡像 onSnapshot）
    const set = this.watchers.get(roomId) ?? new Set<(s: RoomSnapshot) => void>();
    set.add(onChange);
    this.watchers.set(roomId, set);
    return () => { set.delete(onChange); };
  }

  private notify(roomId: string): void {
    const s = this.snapshot(roomId);
    this.watchers.get(roomId)?.forEach((cb) => cb(s));
  }
}

export class InMemoryRoomDirectory implements IRoomDirectory {
  constructor(
    private readonly hub: InMemoryRoomDirectoryHub,
    private readonly roomId: string,
    private readonly localUid: string
  ) {}

  async registerIdentity(entry: {
    userId: string;
    pubKey: string;
    ecdhPubKey?: string;
    introducedBy?: string;
  }): Promise<void> {
    this.hub.register(this.roomId, this.localUid, entry);
  }

  watchIdentities(onChange: (snapshot: RoomSnapshot) => void): () => void {
    return this.hub.watch(this.roomId, onChange);
  }

  async getSnapshot(): Promise<RoomSnapshot> {
    return this.hub.snapshot(this.roomId);
  }
}
