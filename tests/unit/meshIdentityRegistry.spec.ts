/**
 * B6 回歸：meshIdentities 以 dotted field path 只寫自己那一格。
 *
 * 修復前是「讀整張表 → 本地插入自己 → 整份覆寫」。多人同時進場時，人人拿著各自的
 * 舊快照覆寫整張表，後到者會刪掉快照中沒有的他人條目 → 被 meshIdentitiesChangeIsValid
 * （affectedKeys 必須 ⊆ {自己}）判為 permission-denied → 重試預算（5 次約 2 秒）耗盡
 * → registerIdentity 拋錯 → MeshGossipManager.initialize() 整條失敗。
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/firebase', () => ({ db: {} }));

const updateDocMock = vi.fn().mockResolvedValue(undefined);
let snapshotData: Record<string, unknown> = {};
let snapshotExists = true;

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({
    exists: () => snapshotExists,
    data: () => snapshotData,
  })),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
}));

import { updateMeshIdentity } from '../../src/services/meshIdentityRegistry';

const PUB = 'A'.repeat(64); // 合法 Base64 且長度在 40-512 內
const ME = 'uid-me';
const OTHER = 'uid-other';

describe('updateMeshIdentity 寫入形狀（B6）', () => {
  beforeEach(() => {
    updateDocMock.mockClear();
    snapshotExists = true;
    snapshotData = {
      participants: [ME, OTHER],
      // 名冊裡已有別人的條目——修復前的整份覆寫會把它一起寫回（並在快照過期時刪掉它）
      meshIdentities: { [OTHER]: { userId: 'other-user', pubKey: PUB, joinedAt: 1 } },
    };
  });

  it('以 dotted path 只寫自己那一格，不整份覆寫 meshIdentities', async () => {
    await updateMeshIdentity('room-1', ME, 'my-user-id', PUB);

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const payload = updateDocMock.mock.calls[0]![1] as Record<string, unknown>;

    // 只碰自己那一格
    expect(Object.keys(payload).sort()).toEqual([`meshIdentities.${ME}`, 'topology'].sort());
    // 絕不可出現整張表的鍵（那正是造成互相覆寫的寫法）
    expect(payload).not.toHaveProperty('meshIdentities');
    expect(payload[`meshIdentities.${ME}`]).toMatchObject({
      userId: 'my-user-id',
      pubKey: PUB,
    });
    expect(payload['topology']).toBe('mesh');
  });

  it('他人條目不出現在寫入負載中（併發進場不會互相洗掉）', async () => {
    await updateMeshIdentity('room-1', ME, 'my-user-id', PUB);
    const payload = updateDocMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain(OTHER);
    expect(JSON.stringify(payload)).not.toContain('other-user');
  });

  it('introducedBy 是房內成員才寫入', async () => {
    await updateMeshIdentity('room-1', ME, 'my-user-id', PUB, undefined, OTHER);
    const entry = updateDocMock.mock.calls[0]![1][`meshIdentities.${ME}`] as Record<string, unknown>;
    expect(entry['introducedBy']).toBe(OTHER);
  });

  it('introducedBy 非房內成員 → 不寫入（擋垃圾值進名冊）', async () => {
    await updateMeshIdentity('room-1', ME, 'my-user-id', PUB, undefined, 'stranger-uid');
    const entry = updateDocMock.mock.calls[0]![1][`meshIdentities.${ME}`] as Record<string, unknown>;
    expect(entry).not.toHaveProperty('introducedBy');
  });

  it('join 尚未傳播（participants 不含自己）→ 重試後仍失敗即拋出', async () => {
    snapshotData = { participants: [OTHER], meshIdentities: {} };
    await expect(
      updateMeshIdentity('room-1', ME, 'my-user-id', PUB)
    ).rejects.toThrow('join-not-propagated');
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('房間不存在 → 立即拋出，不重試', async () => {
    snapshotExists = false;
    await expect(updateMeshIdentity('room-1', ME, 'my-user-id', PUB)).rejects.toThrow('房間不存在');
  });
});
