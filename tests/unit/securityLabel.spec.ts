/**
 * 每通道安全分級標籤（Spec 012 / GX3 / ADR-0010）：
 * 等級全序、通道判定、送出閘（Q2/Q6 收斂原語）、R2 三態衍生（含逾時升級）。
 */
import { describe, it, expect } from 'vitest';
import {
  meetsMinimum,
  channelSecurityLevel,
  sendGateDecision,
  deriveEncryptionState,
  type SecurityLevel,
} from '../../src/core/transport/securityLabel';

describe('securityLabel', () => {
  describe('meetsMinimum（e2ee > sign-only > plaintext 全序）', () => {
    const cases: Array<[SecurityLevel, SecurityLevel, boolean]> = [
      ['e2ee', 'e2ee', true],
      ['e2ee', 'sign-only', true],
      ['e2ee', 'plaintext', true],
      ['sign-only', 'e2ee', false],
      ['sign-only', 'sign-only', true],
      ['sign-only', 'plaintext', true],
      ['plaintext', 'e2ee', false],
      ['plaintext', 'sign-only', false],
      ['plaintext', 'plaintext', true],
    ];
    for (const [actual, min, ok] of cases) {
      it(`${actual} vs min=${min} → ${ok}`, () => {
        expect(meetsMinimum(actual, min)).toBe(ok);
      });
    }
  });

  describe('channelSecurityLevel（通道→等級判定）', () => {
    it('gossip：金鑰就緒＝e2ee、未就緒＝sign-only（簽章恆有，內容可讀）', () => {
      expect(channelSecurityLevel('gossip', { roomKeyReady: true })).toBe('e2ee');
      expect(channelSecurityLevel('gossip', { roomKeyReady: false })).toBe('sign-only');
      expect(channelSecurityLevel('gossip')).toBe('sign-only');
    });
    it('firestore-fallback：密文 body＝e2ee、明文 body＝plaintext（TLS 只到伺服器不計級）', () => {
      expect(channelSecurityLevel('firestore-fallback', { encryptedBody: true })).toBe('e2ee');
      expect(channelSecurityLevel('firestore-fallback', { encryptedBody: false })).toBe('plaintext');
    });
    it('presence 暫態通道誠實標示為 plaintext（DTLS-only 不計入內容層等級）', () => {
      expect(channelSecurityLevel('presence')).toBe('plaintext');
    });
    it('courier 宣告 e2ee（由收側拒收明文使宣告可驗證）', () => {
      expect(channelSecurityLevel('courier')).toBe('e2ee');
    });
  });

  describe('sendGateDecision（Q2 送出閘＝Q6 最低等級路由閘）', () => {
    it('encrypted → allow（達 e2ee 宣告）', () => {
      expect(sendGateDecision('encrypted', 'e2ee')).toBe('allow');
    });
    it('exchanging → hold（未達但可望改善：暫扣、就緒自動補送）', () => {
      expect(sendGateDecision('exchanging', 'e2ee')).toBe('hold');
    });
    it('plaintext → confirm-degrade（定局降級必須顯式確認）', () => {
      expect(sendGateDecision('plaintext', 'e2ee')).toBe('confirm-degrade');
    });
    it('應用宣告 min=sign-only 時，exchanging/plaintext 房也放行（分級不是布林）', () => {
      expect(sendGateDecision('exchanging', 'sign-only')).toBe('allow');
      expect(sendGateDecision('plaintext', 'sign-only')).toBe('allow');
    });
    it('應用宣告 min=plaintext 時一律放行', () => {
      expect(sendGateDecision('plaintext', 'plaintext')).toBe('allow');
    });
  });

  describe('deriveEncryptionState（R2 三態改衍生；Spec 012 Q2 逾時升級）', () => {
    it('未初始化 → exchanging（未知不誤報明文）', () => {
      expect(
        deriveEncryptionState({ initialized: false, coordinatorActive: false, roomKeyReady: false, exchangeTimedOut: true })
      ).toBe('exchanging');
    });
    it('協調器不可用（無 ECDH）→ plaintext（真降級）', () => {
      expect(
        deriveEncryptionState({ initialized: true, coordinatorActive: false, roomKeyReady: false, exchangeTimedOut: false })
      ).toBe('plaintext');
    });
    it('金鑰就緒 → encrypted（逾時與否無關）', () => {
      expect(
        deriveEncryptionState({ initialized: true, coordinatorActive: true, roomKeyReady: true, exchangeTimedOut: true })
      ).toBe('encrypted');
    });
    it('交換中未逾時 → exchanging', () => {
      expect(
        deriveEncryptionState({ initialized: true, coordinatorActive: true, roomKeyReady: false, exchangeTimedOut: false })
      ).toBe('exchanging');
    });
    it('交換逾時仍無鑰 → plaintext（fail-visible 升級；金鑰事後到位可恢復 encrypted）', () => {
      expect(
        deriveEncryptionState({ initialized: true, coordinatorActive: true, roomKeyReady: false, exchangeTimedOut: true })
      ).toBe('plaintext');
    });
  });
});
