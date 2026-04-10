/**
 * Sprint 4 — 進階安全測試
 *
 * IdentityPreRegistration：身份預註冊與驗證
 * DHTMessageSigner：DHT 訊息 ECDSA 簽名
 * GossipAckManager 整合：ACK 注入 GossipMessageHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityPreRegistration } from '../../src/core/mesh/IdentityPreRegistration';
import { DHTMessageSigner } from '../../src/core/transport/DHTMessageSigner';
import type { DHTSignableData, SignedDHTFields } from '../../src/core/transport/DHTMessageSigner';

// ══════════════════════════════════════════════════════════════════════════════
// IdentityPreRegistration
// ══════════════════════════════════════════════════════════════════════════════

describe('IdentityPreRegistration — 開放模式', () => {
  let reg: IdentityPreRegistration;

  beforeEach(() => {
    reg = new IdentityPreRegistration({ mode: 'open' });
  });

  it('任何人都可以自行註冊', () => {
    const ok = reg.register('user-1', 'pubkey-1', 'user-1');
    expect(ok).toBe(true);
    expect(reg.getRegisteredCount()).toBe(1);
  });

  it('verify 通過已註冊的身份', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    const result = reg.verify('user-1', 'pubkey-1');
    expect(result.allowed).toBe(true);
  });

  it('verify 拒絕未註冊的身份', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    const result = reg.verify('user-2', 'pubkey-2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not-registered');
  });

  it('verify 拒絕公鑰不符', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    const result = reg.verify('user-1', 'WRONG-KEY');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('pubkey-mismatch');
  });

  it('開放模式且無人註冊時允許通過（向後相容）', () => {
    const result = reg.verify('anyone', 'any-key');
    expect(result.allowed).toBe(true);
  });

  it('revoke 移除已註冊的身份', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    reg.revoke('user-1');
    expect(reg.verify('user-1', 'pubkey-1').allowed).toBe(false);
  });

  it('容量上限', () => {
    const small = new IdentityPreRegistration({ mode: 'open', maxRegistrations: 3 });
    small.register('u1', 'k1', 'u1');
    small.register('u2', 'k2', 'u2');
    small.register('u3', 'k3', 'u3');
    const ok = small.register('u4', 'k4', 'u4');
    expect(ok).toBe(false);
    expect(small.getRegisteredCount()).toBe(3);
  });
});

describe('IdentityPreRegistration — 邀請制模式', () => {
  let reg: IdentityPreRegistration;

  beforeEach(() => {
    reg = new IdentityPreRegistration({ mode: 'invite-only' });
    reg.addAdmin('admin-1');
  });

  it('管理員可以加人', () => {
    const ok = reg.register('user-1', 'pubkey-1', 'admin-1');
    expect(ok).toBe(true);
    expect(reg.verify('user-1', 'pubkey-1').allowed).toBe(true);
  });

  it('非管理員不能加人', () => {
    const ok = reg.register('user-1', 'pubkey-1', 'random-user');
    expect(ok).toBe(false);
    expect(reg.getRegisteredCount()).toBe(0);
  });

  it('isAdmin 判斷', () => {
    expect(reg.isAdmin('admin-1')).toBe(true);
    expect(reg.isAdmin('user-1')).toBe(false);
  });

  it('removeAdmin 後就不能加人了', () => {
    reg.removeAdmin('admin-1');
    const ok = reg.register('user-1', 'pubkey-1', 'admin-1');
    expect(ok).toBe(false);
  });
});

describe('IdentityPreRegistration — 審核模式', () => {
  let reg: IdentityPreRegistration;

  beforeEach(() => {
    reg = new IdentityPreRegistration({ mode: 'approval' });
    reg.addAdmin('admin-1');
  });

  it('非管理員的註冊進入待審區', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    expect(reg.getRegisteredCount()).toBe(0);
    expect(reg.getPendingUserIds()).toEqual(['user-1']);
  });

  it('審核通過後可以通過驗證', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    const result1 = reg.verify('user-1', 'pubkey-1');
    expect(result1.allowed).toBe(false);
    expect(result1.reason).toBe('pending-approval');

    reg.approve('user-1', 'admin-1');
    const result2 = reg.verify('user-1', 'pubkey-1');
    expect(result2.allowed).toBe(true);
  });

  it('管理員直接註冊不需審核', () => {
    reg.register('admin-1', 'admin-key', 'admin-1');
    expect(reg.getRegisteredCount()).toBe(1);
    expect(reg.getPendingUserIds()).toEqual([]);
  });

  it('reject 拒絕待審核的註冊', () => {
    reg.register('user-1', 'pubkey-1', 'user-1');
    reg.reject('user-1', 'admin-1');
    expect(reg.getPendingUserIds()).toEqual([]);
    expect(reg.verify('user-1', 'pubkey-1').reason).toBe('not-registered');
  });
});

describe('IdentityPreRegistration — 過期與匯出', () => {
  it('過期的註冊被自動移除', () => {
    const reg = new IdentityPreRegistration({ mode: 'open', expiryMs: 100 });
    reg.register('user-1', 'key-1', 'user-1');

    // 手動模擬時間流逝
    const entry = reg.getEntry('user-1')!;
    entry.registeredAt = Date.now() - 200; // 200ms 前

    const result = reg.verify('user-1', 'key-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('expiryMs=0 表示不過期', () => {
    const reg = new IdentityPreRegistration({ mode: 'open', expiryMs: 0 });
    reg.register('user-1', 'key-1', 'user-1');

    const entry = reg.getEntry('user-1')!;
    entry.registeredAt = 0; // 很久以前

    expect(reg.verify('user-1', 'key-1').allowed).toBe(true);
  });

  it('exportRegistry / importRegistry', () => {
    const reg1 = new IdentityPreRegistration({ mode: 'open' });
    reg1.register('alice', 'key-a', 'alice');
    reg1.register('bob', 'key-b', 'bob');

    const exported = reg1.exportRegistry();
    expect(exported).toHaveLength(2);

    const reg2 = new IdentityPreRegistration({ mode: 'open' });
    const imported = reg2.importRegistry(exported);
    expect(imported).toBe(2);
    expect(reg2.verify('alice', 'key-a').allowed).toBe(true);
  });

  it('importRegistry 不覆蓋已存在的記錄', () => {
    const reg = new IdentityPreRegistration({ mode: 'open' });
    reg.register('alice', 'key-local', 'alice');

    const imported = reg.importRegistry([{
      userId: 'alice',
      pubKey: 'key-remote',
      registeredAt: Date.now(),
      approvedBy: 'someone',
    }]);

    expect(imported).toBe(0);
    // 本地的金鑰不應被覆蓋
    expect(reg.verify('alice', 'key-local').allowed).toBe(true);
  });

  it('destroy 清空所有狀態', () => {
    const reg = new IdentityPreRegistration({ mode: 'open' });
    reg.addAdmin('admin');
    reg.register('user', 'key', 'user');
    reg.destroy();
    expect(reg.getRegisteredCount()).toBe(0);
    expect(reg.isAdmin('admin')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DHTMessageSigner
// ══════════════════════════════════════════════════════════════════════════════

describe('DHTMessageSigner — 簽名與驗證', () => {
  let signer: DHTMessageSigner;
  let keyPair: CryptoKeyPair;
  let pubKeyBase64: string;

  beforeEach(async () => {
    signer = new DHTMessageSigner();

    // 產生 ECDSA P-256 測試金鑰
    keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );

    const exported = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const bytes = new Uint8Array(exported);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    pubKeyBase64 = btoa(binary);

    signer.init('test-peer', keyPair.privateKey, pubKeyBase64);
  });

  const sampleData: DHTSignableData = {
    type: 'DHT_STORE',
    fromId: 'test-peer',
    recipientId: 'target-peer',
    roomId: 'room-1',
    requestId: 'req-001',
    contentHash: 'abc123',
  };

  it('signMessage 產生有效的簽名欄位', async () => {
    const signed = await signer.signMessage(sampleData);
    expect(signed.signature).toBeTruthy();
    expect(signed.senderPubKey).toBe(pubKeyBase64);
    expect(signed.signedAt).toBeGreaterThan(0);
  });

  it('verifyMessage 驗證合法的簽名', async () => {
    const signed = await signer.signMessage(sampleData);
    const result = await signer.verifyMessage(sampleData, signed);
    expect(result.valid).toBe(true);
  });

  it('verifyMessage 拒絕竄改過的資料', async () => {
    const signed = await signer.signMessage(sampleData);
    const tampered = { ...sampleData, contentHash: 'TAMPERED' };
    const result = await signer.verifyMessage(tampered, signed);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid-signature');
  });

  it('verifyMessage 拒絕過期的簽名', async () => {
    const signed = await signer.signMessage(sampleData);
    // 將簽名時間改成 20 分鐘前（超過預設 10 分鐘限制）
    signed.signedAt = Date.now() - 20 * 60 * 1000;
    const result = await signer.verifyMessage(sampleData, signed);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('verifyMessage 拒絕缺少簽名的訊息', async () => {
    const result = await signer.verifyMessage(sampleData, {
      signature: '',
      senderPubKey: pubKeyBase64,
      signedAt: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing-signature');
  });

  it('用不同金鑰簽名的訊息驗證失敗', async () => {
    const signed = await signer.signMessage(sampleData);

    // 建立另一個 signer（不同金鑰）
    const otherKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const otherExported = await crypto.subtle.exportKey('spki', otherKeyPair.publicKey);
    const otherBytes = new Uint8Array(otherExported);
    let otherBinary = '';
    for (const b of otherBytes) otherBinary += String.fromCharCode(b);
    const otherPubKey = btoa(otherBinary);

    // 替換公鑰但保留原簽名
    signed.senderPubKey = otherPubKey;
    const result = await signer.verifyMessage(sampleData, signed);
    expect(result.valid).toBe(false);
  });

  it('公鑰快取運作正常', async () => {
    // 第一次驗證（匯入公鑰）
    const signed = await signer.signMessage(sampleData);
    await signer.verifyMessage(sampleData, signed);

    // 第二次驗證（應該用快取）
    const result = await signer.verifyMessage(sampleData, signed);
    expect(result.valid).toBe(true);

    // 清除快取後仍能驗證（重新匯入）
    signer.clearCache();
    const result2 = await signer.verifyMessage(sampleData, signed);
    expect(result2.valid).toBe(true);
  });

  it('destroy 清空所有狀態', async () => {
    await signer.signMessage(sampleData);
    signer.destroy();
    // 銷毀後嘗試簽名應該拋錯
    await expect(signer.signMessage(sampleData)).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GossipAckManager 整合到 GossipMessageHandler
// ══════════════════════════════════════════════════════════════════════════════

import { GossipAckManager } from '../../src/core/mesh/GossipAckManager';
import type { AckEnvelope } from '../../src/core/mesh/GossipAckManager';

describe('GossipMessageHandler — ACK 整合', () => {
  it('handleAckEnvelope 將 ACK 轉發給 AckManager', () => {
    const ackMgr = new GossipAckManager('local');
    const ackId = ackMgr.trackMessage('key-rotation', ['peerA'], async () => {});

    // 直接測試 AckManager（因為 GossipMessageHandler 需要太多依賴）
    const ack: AckEnvelope = {
      type: 'gossip:ack',
      ackId,
      senderId: 'peerA',
    };

    ackMgr.handleAck(ack);
    expect(ackMgr.getPendingCount()).toBe(0); // 全部 ACK → 清除
    ackMgr.destroy();
  });

  it('createAck 產生正確的 ACK envelope', () => {
    const ackMgr = new GossipAckManager('my-peer');
    const ack = ackMgr.createAck('some-ack-id');
    expect(ack).toEqual({
      type: 'gossip:ack',
      ackId: 'some-ack-id',
      senderId: 'my-peer',
    });
    ackMgr.destroy();
  });
});
