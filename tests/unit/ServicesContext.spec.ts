/**
 * 示範使用 Mock Ports 測試：依賴 IRoomService / IChatStorage 的邏輯可透過注入 Mock 測試。
 */
import { describe, it, expect } from 'vitest';
import type { IRoomService, IChatStorage } from '../../src/ports';
import type { P2PRoom, ChatMessage } from '../../src/types';

describe('Ports / 可插拔與測試', () => {
  it('Mock IRoomService 可回傳固定房間', async () => {
    const mockRoom: P2PRoom = {
      roomId: 'test-room-1',
      ownerUid: 'owner-1',
      ownerName: 'Owner',
      participants: ['owner-1', 'user-2'],
      status: 'open',
      isPrivate: false,
      createdAt: Date.now(),
    };

    const mockRoomService: IRoomService = {
      createRoom: async () => 'new-room-id',
      closeAllUserRooms: async () => {},
      getRoom: async () => mockRoom,
      isRoomTimeout: () => false,
      joinRoom: async () => {},
      leaveRoom: async () => {},
      closeRoom: async () => {},
      activateRoom: async () => {},
      subscribeRoom: () => () => {},
      subscribeUserRooms: () => () => {},
      subscribePublicRooms: () => () => {},
      updateMeshIdentity: async () => {},
      getMeshIdentities: async () => new Map(),
    };

    const room = await mockRoomService.getRoom('test-room-1');
    expect(room).not.toBeNull();
    expect(room?.roomId).toBe('test-room-1');
    expect(room?.status).toBe('open');
    expect(room?.participants).toHaveLength(2);
  });

  it('Mock IChatStorage 可回傳固定訊息列表', async () => {
    const stored: ChatMessage[] = [];

    const mockChatStorage: IChatStorage = {
      saveChatMessage: async (msg) => {
        stored.push(msg);
      },
      getChatMessages: async () => [...stored],
      updateChatMessage: async (messageId, updates) => {
        const i = stored.findIndex((m) => m.messageId === messageId);
        if (i >= 0) Object.assign(stored[i], updates);
      },
      deleteChatMessage: async () => {},
    };

    await mockChatStorage.saveChatMessage(
      {
        messageId: 'msg-1',
        from: 'user-1',
        content: 'Hello',
        timestamp: Date.now(),
      },
      'room-1'
    );
    const list = await mockChatStorage.getChatMessages('room-1');
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('Hello');
  });
});
