/**
 * IRoomCatalog 的純記憶體參考實作（Spec 014 T2）。零後端、同 JS context 互通；
 * 形狀比照 InMemoryRoomDirectory（Hub 共享、實例綁 Hub）。自架後端照此語義實作。
 */

import type { CatalogRoom, IRoomCatalog } from '../../ports/IRoomCatalog';

export class InMemoryRoomCatalogHub {
  private rooms = new Map<string, CatalogRoom>();
  private watchers = new Set<(rooms: CatalogRoom[]) => void>();
  private seq = 0;

  snapshot(): CatalogRoom[] {
    return [...this.rooms.values()].map((r) => ({ ...r }));
  }

  upsert(room: CatalogRoom): void {
    this.rooms.set(room.id, { ...room });
    this.emit();
  }

  remove(id: string): void {
    if (this.rooms.delete(id)) this.emit();
  }

  nextId(): string {
    return `room-${++this.seq}`;
  }

  addWatcher(cb: (rooms: CatalogRoom[]) => void): () => void {
    this.watchers.add(cb);
    cb(this.snapshot()); // 訂閱當下先收一次（對齊 watchIdentities 語義）
    return () => this.watchers.delete(cb);
  }

  private emit(): void {
    const snap = this.snapshot();
    this.watchers.forEach((w) => {
      try { w(snap); } catch { /* watcher 錯誤不擊落其他 watcher */ }
    });
  }
}

export class InMemoryRoomCatalog implements IRoomCatalog {
  constructor(private hub: InMemoryRoomCatalogHub) {}

  async list(): Promise<CatalogRoom[]> {
    return this.hub.snapshot();
  }

  watch(onChange: (rooms: CatalogRoom[]) => void): () => void {
    return this.hub.addWatcher(onChange);
  }

  async publish(room: Omit<CatalogRoom, 'id'> & { id?: string }): Promise<string> {
    const id = room.id ?? this.hub.nextId();
    this.hub.upsert({ ...room, id });
    return id;
  }

  async unpublish(id: string): Promise<void> {
    this.hub.remove(id); // 冪等
  }
}
