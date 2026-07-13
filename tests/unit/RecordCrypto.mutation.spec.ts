/**
 * RecordCrypto 偵測邊界——殺 Stryker mutation 存活者
 *
 * mutation 發現 isEncryptedContent / contentEpoch 的「不算密文」各分支未逐條測到
 * （property 測試只驗 happy path）。這裡逐條釘住：每一種「看似密文卻不是」的畸形
 * 都必須被正確判為非密文——這是盲信使誤判防線（明文不得被當密文、反之亦然）。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { isEncryptedContent, contentEpoch, encryptRecordContent } from '../../src/core/mesh/RecordCrypto';

const MARKER = '"v":"nrec1"';

describe('isEncryptedContent — 偵測邊界（殺 mutant）', () => {
  it('真密文信封 → true', () => {
    expect(isEncryptedContent(JSON.stringify({ v: 'nrec1', ct: 'AA', iv: 'BB', ep: 0 }))).toBe(true);
  });

  // 每個案例都「含 marker 子字串」以強制走到 parse 後的逐條驗證分支
  it('含 marker 但非合法 JSON → false（parse catch 分支）', () => {
    expect(isEncryptedContent(`{${MARKER}, ct: broken`)).toBe(false);
  });

  it('marker 只出現在「值」裡、實際 v 不是 nrec1 → false', () => {
    // 明文訊息剛好提到 marker 字串，不得誤判為密文
    expect(isEncryptedContent(JSON.stringify({ v: 'nrec2', note: MARKER, ct: 'AA', iv: 'BB' }))).toBe(false);
  });

  it('v=nrec1 但 ct 非字串 → false', () => {
    expect(isEncryptedContent(JSON.stringify({ v: 'nrec1', ct: 123, iv: 'BB' }))).toBe(false);
  });

  it('v=nrec1 但 iv 非字串 → false', () => {
    expect(isEncryptedContent(JSON.stringify({ v: 'nrec1', ct: 'AA', iv: null }))).toBe(false);
  });

  it('v=nrec1 但缺 ct/iv → false', () => {
    expect(isEncryptedContent(JSON.stringify({ v: 'nrec1' }))).toBe(false);
  });

  it('完全沒有 marker 的明文 → false（marker 快篩分支）', () => {
    expect(isEncryptedContent('hello world')).toBe(false);
    expect(isEncryptedContent(JSON.stringify({ hello: 'world' }))).toBe(false);
  });

  it('空字串 → false', () => {
    expect(isEncryptedContent('')).toBe(false);
  });
});

describe('contentEpoch — 讀 epoch（殺 mutant）', () => {
  it('真密文回傳其 epoch（非 0 也正確）', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const content = await encryptRecordContent('hi', key, 7);
    expect(contentEpoch(content)).toBe(7);
  });

  it('明文 → null', () => {
    expect(contentEpoch('plain text')).toBeNull();
    expect(contentEpoch(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  it('含 marker 但畸形（非合法密文）→ null', () => {
    expect(contentEpoch(`{${MARKER}, broken`)).toBeNull();
  });
});
