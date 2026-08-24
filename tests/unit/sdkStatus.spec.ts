import { describe, it, expect } from 'vitest';
import {
  toTransportState,
  toEncryptionState,
  deriveStatus,
  statusEquals,
  type InternalConnectionState,
} from '../../src/core/messaging/status';
import type { EncryptionState } from '../../src/core/messaging/encryptionGate';

describe('SDK 狀態純映射（Spec 024 T1）', () => {
  it('傳輸軸：五個內部態全數有映射，無漏', () => {
    const cases: Array<[InternalConnectionState, string]> = [
      ['idle', 'connecting'],
      ['connecting', 'connecting'],
      ['connected', 'p2p'],
      ['failed', 'offline'],
      ['closed', 'offline'],
    ];
    for (const [input, expected] of cases) {
      expect(toTransportState(input)).toBe(expected);
    }
  });

  it('加密軸：三個內部態全數有映射，plaintext 如實透出為 degraded', () => {
    const cases: Array<[EncryptionState, string]> = [
      ['encrypted', 'ready'],
      ['exchanging', 'pending'],
      ['plaintext', 'degraded'],
    ];
    for (const [input, expected] of cases) {
      expect(toEncryptionState(input)).toBe(expected);
    }
  });

  it('deriveStatus 組合兩軸且互不干擾', () => {
    expect(deriveStatus('connected', 'exchanging')).toEqual({
      transport: 'p2p',
      encryption: 'pending', // P2P 通了但金鑰未就緒——真實中間態不得被合成藏掉
    });
    expect(deriveStatus('connecting', 'encrypted')).toEqual({
      transport: 'connecting',
      encryption: 'ready',
    });
  });

  it('statusEquals：同值 true、任一軸不同 false（onStatus 去抖依據）', () => {
    const a = deriveStatus('connected', 'encrypted');
    expect(statusEquals(a, deriveStatus('connected', 'encrypted'))).toBe(true);
    expect(statusEquals(a, deriveStatus('connected', 'exchanging'))).toBe(false);
    expect(statusEquals(a, deriveStatus('idle', 'encrypted'))).toBe(false);
  });
});
