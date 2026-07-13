import { describe, it, expect } from 'vitest';
import {
  InMemoryRoomDirectoryHub,
  InMemoryRoomDirectory,
} from '../../src/core/mesh/InMemoryRoomDirectory';
import type { RoomSnapshot } from '../../src/ports/IRoomDirectory';

/**
 * 證明 IRoomDirectory 發現縫可脫離 Firebase:兩個 peer 共用一顆記憶體 Hub 即互相發現,
 * 語義鏡像 Firestore(watch 首次帶目前狀態、register bump joinedAt 供 rejoin 偵測)。
 */
describe('InMemoryRoomDirectory (P2b 發現注入證明)', () => {
  it('A 註冊 → B watch 收得到 A 的身分(同房互相發現,無 Firebase)', () => {
    const hub = new InMemoryRoomDirectoryHub();
    const a = new InMemoryRoomDirectory(hub, 'room1', 'uid-a');
    const b = new InMemoryRoomDirectory(hub, 'room1', 'uid-b');
    const snaps: RoomSnapshot[] = [];
    b.watchIdentities((s) => snaps.push(s));
    void a.registerIdentity({ userId: 'user-a', pubKey: 'pkA' });
    const last = snaps[snaps.length - 1];
    expect(last.meshIdentities['uid-a']?.userId).toBe('user-a');
    expect(last.participants).toContain('uid-a');
  });

  it('watch 首次立即帶目前狀態(鏡像 onSnapshot 首快照)', () => {
    const hub = new InMemoryRoomDirectoryHub();
    void new InMemoryRoomDirectory(hub, 'r', 'uid-a').registerIdentity({ userId: 'ua', pubKey: 'p' });
    const snaps: RoomSnapshot[] = [];
    new InMemoryRoomDirectory(hub, 'r', 'uid-b').watchIdentities((s) => snaps.push(s));
    expect(snaps[0].meshIdentities['uid-a']?.userId).toBe('ua'); // 訂閱當下就有
  });

  it('重複註冊(rejoin)會 bump joinedAt', async () => {
    const hub = new InMemoryRoomDirectoryHub();
    const a = new InMemoryRoomDirectory(hub, 'r', 'uid-a');
    await a.registerIdentity({ userId: 'ua', pubKey: 'p' });
    const first = (await a.getSnapshot()).meshIdentities['uid-a']!.joinedAt as number;
    // 稍後再註冊,joinedAt 不得倒退(通常前進;至少 >=)
    await a.registerIdentity({ userId: 'ua', pubKey: 'p' });
    const second = (await a.getSnapshot()).meshIdentities['uid-a']!.joinedAt as number;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('不同房互不干擾', () => {
    const hub = new InMemoryRoomDirectoryHub();
    const snaps: RoomSnapshot[] = [];
    new InMemoryRoomDirectory(hub, 'roomX', 'uid-b').watchIdentities((s) => snaps.push(s));
    void new InMemoryRoomDirectory(hub, 'roomY', 'uid-a').registerIdentity({ userId: 'ua', pubKey: 'p' });
    // roomX 的 watcher 只該收到自己房的首快照(空),不含 roomY 的註冊
    expect(snaps.every((s) => !s.meshIdentities['uid-a'])).toBe(true);
  });

  it('取消 watch 後不再收到更新', () => {
    const hub = new InMemoryRoomDirectoryHub();
    const snaps: RoomSnapshot[] = [];
    const unsub = new InMemoryRoomDirectory(hub, 'r', 'uid-b').watchIdentities((s) => snaps.push(s));
    const n = snaps.length;
    unsub();
    void new InMemoryRoomDirectory(hub, 'r', 'uid-a').registerIdentity({ userId: 'ua', pubKey: 'p' });
    expect(snaps.length).toBe(n); // 沒有新增
  });
});
