/**
 * Spec 012 Q2：MeshChatService 出口閘——金鑰未就緒不送明文。
 *  - encrypted → 放行；exchanging → 暫扣等 keyx（就緒自動補送／逾時 fail-visible）；
 *  - plaintext → 拋 PlaintextConfirmRequiredError；allowDegraded（使用者確認）才放行；
 *  - reaction/read 未達等級靜默略過；game 與 chat 同閘。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshChatService } from '../../src/features/chat/MeshChatService';
import { PlaintextConfirmRequiredError } from '../../src/features/chat/encryptionGate';
import type { EncryptionState } from '../../src/types';

type ManagerStub = {
  sendMessage: ReturnType<typeof vi.fn>;
  getEncryptionState: ReturnType<typeof vi.fn>;
  waitForSendKey: ReturnType<typeof vi.fn>;
};

function makeService(state: EncryptionState, waitResult = false) {
  const storage = {
    saveChatMessage: vi.fn().mockResolvedValue(undefined),
    getChatMessages: vi.fn().mockResolvedValue([]),
  };
  const svc = new MeshChatService('room-g', 'uid-g', storage as never);
  const manager: ManagerStub = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getEncryptionState: vi.fn().mockReturnValue(state),
    waitForSendKey: vi.fn().mockResolvedValue(waitResult),
  };
  Object.assign(svc as unknown as { meshGossipManager: ManagerStub }, { meshGossipManager: manager });
  return { svc, manager, storage };
}

describe('Spec 012 Q2：MeshChatService 出口閘', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypted → 直接放行（不等待）', async () => {
    const { svc, manager } = makeService('encrypted');
    await svc.sendMessage('hi', 'm1');
    expect(manager.sendMessage).toHaveBeenCalledWith('hi', 'm1', undefined, expect.any(Number));
    expect(manager.waitForSendKey).not.toHaveBeenCalled();
  });

  it('exchanging → 暫扣；金鑰就緒 → 自動補送（原 promise 續走）', async () => {
    const { svc, manager } = makeService('exchanging', true);
    await svc.sendMessage('held', 'm2');
    expect(manager.waitForSendKey).toHaveBeenCalledTimes(1);
    expect(manager.sendMessage).toHaveBeenCalledWith('held', 'm2', undefined, expect.any(Number));
  });

  it('exchanging → 暫扣逾時無鑰 → 拋 PlaintextConfirmRequiredError、不送出', async () => {
    const { svc, manager, storage } = makeService('exchanging', false);
    await expect(svc.sendMessage('never-plain', 'm3')).rejects.toBeInstanceOf(PlaintextConfirmRequiredError);
    expect(manager.sendMessage).not.toHaveBeenCalled();
    expect(storage.saveChatMessage).not.toHaveBeenCalled(); // 未送出＝本機也不落聊天紀錄
  });

  it('plaintext（真明文房/已逾時衍生）→ 直接拋，不進 hold', async () => {
    const { svc, manager } = makeService('plaintext');
    await expect(svc.sendMessage('x', 'm4')).rejects.toBeInstanceOf(PlaintextConfirmRequiredError);
    expect(manager.waitForSendKey).not.toHaveBeenCalled();
    expect(manager.sendMessage).not.toHaveBeenCalled();
  });

  it('plaintext + allowDegraded（使用者已確認）→ 放行明文（R2 顯式降級）', async () => {
    const { svc, manager } = makeService('plaintext');
    await svc.sendMessage('consented', 'm5', { allowDegraded: true });
    expect(manager.sendMessage).toHaveBeenCalledWith('consented', 'm5', undefined, expect.any(Number));
  });

  it('sendGameEnvelope 與 chat 同閘：plaintext 房拋錯不開局', async () => {
    const { svc, manager } = makeService('plaintext');
    await expect(
      svc.sendGameEnvelope({ v: 1, id: 'g1', type: 't', from: 'uid-g', payload: {} } as never)
    ).rejects.toBeInstanceOf(PlaintextConfirmRequiredError);
    expect(manager.sendMessage).not.toHaveBeenCalled();
  });

  it('sendReaction / sendRead 未達等級 → 靜默略過（不拋、不送）', async () => {
    const { svc, manager } = makeService('exchanging');
    await expect(svc.sendReaction('m1', '👍', 'add')).resolves.toBeUndefined();
    await expect(svc.sendRead('watermark-1')).resolves.toBeUndefined();
    expect(manager.sendMessage).not.toHaveBeenCalled();
    expect(manager.waitForSendKey).not.toHaveBeenCalled(); // 不 hold 阻塞 UI
  });

  it('sendReaction / sendRead 於 encrypted 照常送出', async () => {
    const { svc, manager } = makeService('encrypted');
    await svc.sendReaction('m1', '👍', 'add');
    await svc.sendRead('w2');
    expect(manager.sendMessage).toHaveBeenCalledTimes(2);
  });
});
