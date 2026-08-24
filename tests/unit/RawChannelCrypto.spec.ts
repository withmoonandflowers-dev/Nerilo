import { describe, it, expect } from 'vitest';
import { sealRawFrame, openRawFrame, type RawKeyPort } from '../../src/core/p2p/RawChannelCrypto';

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function portOf(ring: Map<number, CryptoKey>, sendEpoch: number | null): RawKeyPort {
  return {
    getSendKeyWithEpoch: () => {
      if (sendEpoch === null) return null;
      const key = ring.get(sendEpoch);
      return key ? { key, epoch: sendEpoch } : null;
    },
    getKeyForEpoch: (ep) => ring.get(ep),
  };
}

describe('RawChannelCrypto（Spec 023 T1，raw-v1 二進位格式）', () => {
  it('二進位往返：密封→開封還原原 bytes，epoch 入 frame', async () => {
    const key = await makeKey();
    const ring = new Map([[3, key]]);
    const port = portOf(ring, 3);
    const payload = new Uint8Array([1, 2, 3, 250, 251, 252]);

    const frame = await sealRawFrame(port, payload);
    expect(frame).not.toBeNull();
    expect(frame![0]).toBe(0x01); // ver
    expect(new DataView(frame!.buffer).getUint32(2, false)).toBe(3); // epoch BE

    const out = await openRawFrame(port, frame!);
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...(out as Uint8Array)]).toEqual([...payload]);
  });

  it('字串往返：型別跟隨送端（字串進字串出）', async () => {
    const key = await makeKey();
    const port = portOf(new Map([[0, key]]), 0);
    const frame = await sealRawFrame(port, '{"t":"i","w":[[556,7]]}');
    expect(typeof (await openRawFrame(port, frame!))).toBe('string');
    expect(await openRawFrame(port, frame!)).toBe('{"t":"i","w":[[556,7]]}');
  });

  it('金鑰未就緒：seal 回 null（丟棄語義的依據），不拋錯不排隊', async () => {
    const port = portOf(new Map(), null);
    expect(await sealRawFrame(port, 'x')).toBeNull();
  });

  it('收端無該代金鑰：open 拋錯（呼叫端丟棄＋計數）', async () => {
    const kA = await makeKey();
    const sender = portOf(new Map([[5, kA]]), 5);
    const receiver = portOf(new Map([[4, await makeKey()]]), 4); // 沒有 epoch 5
    const frame = await sealRawFrame(sender, 'hello');
    await expect(openRawFrame(receiver, frame!)).rejects.toThrow(/no room key for epoch 5/);
  });

  it('輪替窗兩代並存：收端持前代金鑰仍可開舊 frame，新 frame 用新代（不停流）', async () => {
    const k0 = await makeKey();
    const k1 = await makeKey();
    const oldSender = portOf(new Map([[0, k0]]), 0);
    const newSender = portOf(new Map([[0, k0], [1, k1]]), 1);
    const receiver = portOf(new Map([[0, k0], [1, k1]]), 1); // 保留前代（既有機制）

    const oldFrame = await sealRawFrame(oldSender, 'old');
    const newFrame = await sealRawFrame(newSender, 'new');
    expect(await openRawFrame(receiver, oldFrame!)).toBe('old');
    expect(await openRawFrame(receiver, newFrame!)).toBe('new');
  });

  it('竄改偵測：ciphertext 翻一個 bit → GCM 驗證失敗拋錯', async () => {
    const key = await makeKey();
    const port = portOf(new Map([[0, key]]), 0);
    const frame = await sealRawFrame(port, 'integrity');
    frame![frame!.length - 1] ^= 0xff;
    await expect(openRawFrame(port, frame!)).rejects.toThrow();
  });

  it('格式防禦：太短/未知版本拒收', async () => {
    const key = await makeKey();
    const port = portOf(new Map([[0, key]]), 0);
    await expect(openRawFrame(port, new Uint8Array(10))).rejects.toThrow(/too short/);
    const frame = await sealRawFrame(port, 'v');
    frame![0] = 0x7e;
    await expect(openRawFrame(port, frame!)).rejects.toThrow(/version/);
  });
});
