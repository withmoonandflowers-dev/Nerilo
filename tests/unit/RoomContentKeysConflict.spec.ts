import { describe, it, expect, vi } from 'vitest';
import { RoomContentKeyRing } from '../../src/core/mesh/RoomContentKeys';
import { encryptRecordContent } from '../../src/core/mesh/RecordCrypto';
import { logger } from '../../src/utils/logger';

/**
 * Spec 022 驗收（V1/V2/V4/V5/V6/V6b）：同代異鑰不再靜默覆寫。
 * characterization 原釘的現況（後到覆寫、先到密文解不開）已由本組測試取代——
 * 舊行為見 git 歷史（T1 記錄）。
 */

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

describe('RoomContentKeyRing 同代異鑰（Spec 022）', () => {
  it('V1 同代同產生方重複安裝：冪等，不記衝突、不重複觸發補顯示（hydrate 重放安全）', async () => {
    const ring = new RoomContentKeyRing('r', 'me');
    const installed: number[] = [];
    ring.setOnKeyInstalled((ep) => installed.push(ep));
    const k = await aesKey();
    ring.setContentKey(k, 2, 'producer-A');
    ring.setContentKey(k, 2, 'producer-A'); // hydrate 重放
    ring.setContentKey(k, 2, 'producer-A');
    expect(installed).toEqual([2]);
    expect(ring.getKeyConflicts().epochs).toEqual([]);
  });

  it('V2+V5 同代不同產生方：先到勝出、先到方密文照解（不倒退）、後到被拒、衝突可查', async () => {
    const ring = new RoomContentKeyRing('r', 'me');
    const k1 = await aesKey();
    const k2 = await aesKey();
    ring.setContentKey(k1, 3, 'producer-A');
    const ciphertextByK1 = await encryptRecordContent('first-key-message', k1, 3);

    ring.setContentKey(k2, 3, 'producer-B'); // 後到的不同產生方

    // V5：先到金鑰不動——先到方的密文仍解得開（現況病灶是這裡會 rejects）
    expect(await ring.decryptEnvelope(ciphertextByK1)).toBe('first-key-message');
    // V2：衝突被記錄
    expect(ring.getKeyConflicts()).toEqual({ epochs: [3], requestLimitReached: false });
  });

  it('V3 前半＋V6b：衝突觸發換代回呼與告警各一次（同 epoch 重放不重複）', async () => {
    const ring = new RoomContentKeyRing('r', 'me');
    const warnSpy = vi.spyOn(logger, 'warn');
    const conflictEpochs: number[] = [];
    ring.setOnKeyConflict((ep) => conflictEpochs.push(ep));

    ring.setContentKey(await aesKey(), 1, 'A');
    ring.setContentKey(await aesKey(), 1, 'B'); // 衝突
    ring.setContentKey(await aesKey(), 1, 'B'); // 同衝突重放
    ring.setContentKey(await aesKey(), 1, 'C'); // 同 epoch 第三把——仍同一 epoch，不再吼

    expect(conflictEpochs).toEqual([1]); // 每 epoch 只請求一次
    const conflictWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('key conflict'));
    expect(conflictWarns).toHaveLength(1); // 每 epoch 只吼一次
    // V6b：日誌含兩位產生方身分（現場可診斷）
    expect(conflictWarns[0]![1]).toMatchObject({ epoch: 1, firstProducer: 'A', rejectedProducer: 'B' });
    warnSpy.mockRestore();
  });

  it('V4 會話上限：3 次後不再請求換代，但衝突仍如實記錄', async () => {
    const ring = new RoomContentKeyRing('r', 'me');
    let requests = 0;
    ring.setOnKeyConflict(() => requests++);
    for (let ep = 1; ep <= 5; ep++) {
      ring.setContentKey(await aesKey(), ep, 'A');
      ring.setContentKey(await aesKey(), ep, 'B'); // 每代都衝突（持續分歧的病態情境）
    }
    expect(requests).toBe(3); // MAX_REDISTRIBUTION_REQUESTS
    const st = ring.getKeyConflicts();
    expect(st.epochs).toEqual([1, 2, 3, 4, 5]); // 偵測不受上限影響
    expect(st.requestLimitReached).toBe(true);
  });

  it('V6 清環（退明文）一併清掉衝突記錄與請求計數', async () => {
    const ring = new RoomContentKeyRing('r', 'me');
    let requests = 0;
    ring.setOnKeyConflict(() => requests++);
    ring.setContentKey(await aesKey(), 1, 'A');
    ring.setContentKey(await aesKey(), 1, 'B');
    expect(ring.getKeyConflicts().epochs).toEqual([1]);

    ring.setContentKey(null);
    expect(ring.getKeyConflicts()).toEqual({ epochs: [], requestLimitReached: false });
    // 清環後同 epoch 再衝突：視為新會話狀態，照樣可再請求
    ring.setContentKey(await aesKey(), 1, 'A');
    ring.setContentKey(await aesKey(), 1, 'B');
    expect(requests).toBe(2);
  });

  it('產生方自裝路徑（無 producer 參數）＝本機身分；與遠端同代異鑰照樣偵測', async () => {
    const ring = new RoomContentKeyRing('r', 'me-user');
    ring.setContentKey(await aesKey(), 0); // applyLocalKey 路徑：producer 預設本機 userId
    ring.setContentKey(await aesKey(), 0, 'remote-producer');
    expect(ring.getKeyConflicts().epochs).toEqual([0]);
  });
});
