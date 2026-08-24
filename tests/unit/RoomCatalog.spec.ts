import { describe, it, expect } from 'vitest';
import { InMemoryRoomCatalog, InMemoryRoomCatalogHub } from '../../src/core/mesh/InMemoryRoomCatalog';
import type { CatalogRoom } from '../../src/ports/IRoomCatalog';

/**
 * Spec 014 T4：IRoomCatalog 契約測試（InMemory 參考實作）。
 * Firestore 版跑同語義的整合測試（tests/integration/room-catalog.spec.ts，emulator 下執行）。
 */
describe('IRoomCatalog 契約（InMemory 參考實作）', () => {
  it('publish 回權威 id（給定沿用、未給生成）；list 看得到', async () => {
    const hub = new InMemoryRoomCatalogHub();
    const cat = new InMemoryRoomCatalog(hub);

    const idA = await cat.publish({ id: 'lobby-1', name: '練習場', meta: { mode: 'pvp' } });
    expect(idA).toBe('lobby-1');
    const idB = await cat.publish({ name: '未命名' });
    expect(idB).toBeTruthy();

    const rooms = await cat.list();
    expect(rooms.map((r) => r.id).sort()).toEqual([idA, idB].sort());
    expect(rooms.find((r) => r.id === 'lobby-1')?.meta).toEqual({ mode: 'pvp' }); // meta 原樣保存
  });

  it('watch：訂閱當下先收一次，之後每次變更各一次；退訂即停', async () => {
    const hub = new InMemoryRoomCatalogHub();
    const cat = new InMemoryRoomCatalog(hub);
    await cat.publish({ id: 'r1' });

    const seen: CatalogRoom[][] = [];
    const off = cat.watch((rooms) => seen.push(rooms));
    expect(seen).toHaveLength(1); // 初始快照
    expect(seen[0]!.map((r) => r.id)).toEqual(['r1']);

    await cat.publish({ id: 'r2' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.map((r) => r.id).sort()).toEqual(['r1', 'r2']);

    off();
    await cat.publish({ id: 'r3' });
    expect(seen).toHaveLength(2); // 退訂後不再收
  });

  it('unpublish：房消失且冪等（不存在不拋）', async () => {
    const hub = new InMemoryRoomCatalogHub();
    const cat = new InMemoryRoomCatalog(hub);
    await cat.publish({ id: 'gone' });
    await cat.unpublish('gone');
    expect(await cat.list()).toEqual([]);
    await expect(cat.unpublish('gone')).resolves.toBeUndefined(); // 冪等
    await expect(cat.unpublish('never-existed')).resolves.toBeUndefined();
  });

  it('同 hub 多實例互通（大廳語義：A 公告、B 看得到）', async () => {
    const hub = new InMemoryRoomCatalogHub();
    const a = new InMemoryRoomCatalog(hub);
    const b = new InMemoryRoomCatalog(hub);
    await a.publish({ id: 'host-room', name: 'A 的房' });
    expect((await b.list()).map((r) => r.id)).toEqual(['host-room']);
  });
});
