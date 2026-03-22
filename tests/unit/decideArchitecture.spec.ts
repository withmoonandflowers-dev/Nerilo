/**
 * 測試 decideArchitecture — P2P 拓撲選擇純函式
 * 確保星型 / Mesh 切換邏輯正確，不因重構而退化。
 */
import { describe, it, expect } from 'vitest';
import { decideArchitecture } from '../../src/features/chat/hooks/useP2PArchitecture';
import type { P2PRoom } from '../../src/types';

function makeRoom(overrides: Partial<P2PRoom> = {}): P2PRoom {
  return {
    roomId: 'room-test',
    ownerUid: 'owner-1',
    ownerName: 'Owner',
    participants: [],
    status: 'open',
    isPrivate: false,
    createdAt: Date.now(),
    topology: 'star',
    ...overrides,
  };
}

describe('decideArchitecture', () => {
  describe('星型拓撲（Star）', () => {
    it('0 人時選擇 star', () => {
      const room = makeRoom({ participants: [] });
      const result = decideArchitecture(room);
      expect(result.type).toBe('star');
      expect(result.participantCount).toBe(0);
    });

    it('1 人時選擇 star', () => {
      const room = makeRoom({ participants: ['u1'] });
      const result = decideArchitecture(room);
      expect(result.type).toBe('star');
    });

    it('2 人時選擇 star（最佳雙人連線）', () => {
      const room = makeRoom({ participants: ['u1', 'u2'] });
      const result = decideArchitecture(room);
      expect(result.type).toBe('star');
      expect(result.participantCount).toBe(2);
    });
  });

  describe('Mesh 拓撲', () => {
    it('3 人時切換為 mesh', () => {
      const room = makeRoom({ participants: ['u1', 'u2', 'u3'] });
      const result = decideArchitecture(room);
      expect(result.type).toBe('mesh');
      expect(result.participantCount).toBe(3);
    });

    it('5 人時使用 mesh', () => {
      const room = makeRoom({ participants: ['u1', 'u2', 'u3', 'u4', 'u5'] });
      const result = decideArchitecture(room);
      expect(result.type).toBe('mesh');
    });

    it('topology 明確設為 mesh 時強制使用 mesh（即使只有 1 人）', () => {
      const room = makeRoom({ participants: ['u1'], topology: 'mesh' });
      const result = decideArchitecture(room);
      expect(result.type).toBe('mesh');
      expect(result.reason).toMatch(/explicit/i);
    });
  });

  describe('overrideParticipantCount', () => {
    it('覆蓋參與者數量後正確決策 — 2 人覆蓋值 → star', () => {
      const room = makeRoom({ participants: ['u1'] }); // 實際 1 人
      const result = decideArchitecture(room, 2);      // 覆蓋為 2
      expect(result.type).toBe('star');
      expect(result.participantCount).toBe(2);
    });

    it('覆蓋參與者數量後正確決策 — 3 人覆蓋值 → mesh', () => {
      const room = makeRoom({ participants: ['u1', 'u2'] }); // 實際 2 人
      const result = decideArchitecture(room, 3);             // 覆蓋為 3
      expect(result.type).toBe('mesh');
      expect(result.participantCount).toBe(3);
    });

    it('topology=mesh 時 override 不影響結果', () => {
      const room = makeRoom({ participants: [], topology: 'mesh' });
      const result = decideArchitecture(room, 1); // 即使 1 人也是 mesh
      expect(result.type).toBe('mesh');
    });
  });

  describe('回傳值結構', () => {
    it('回傳 type、participantCount、reason 三個欄位', () => {
      const room = makeRoom({ participants: ['u1', 'u2'] });
      const result = decideArchitecture(room);
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('participantCount');
      expect(result).toHaveProperty('reason');
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
