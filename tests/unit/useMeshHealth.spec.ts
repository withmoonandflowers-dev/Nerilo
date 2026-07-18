/**
 * useMeshHealth／bridgeExpectedPeers 單元測試（Spec 011 Q4/Q5；V5 橋接用量斷言）
 *
 * V5 的可執行證明：partial mesh 房（7+ 人，k<n-1）在鄰居連滿 k 時「不再每訊息
 * 觸發 Firestore 備援雙寫」；≤6 人房期望值仍為 n-1，行為與 Spec 011 之前一致。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
// 根層 node_modules 無 vue（vue 只屬 web-vue 子包）；測試檔直取子包實體。
// 被測的 composable 自己的 `import 'vue'` 由 Vite 從 importer 路徑向上解析到同一份。
import { ref } from '../../web-vue/node_modules/vue';
import {
  bridgeExpectedPeers,
  useMeshHealth,
} from '../../web-vue/app/composables/useMeshHealth';

describe('bridgeExpectedPeers（Q4b：min(n-1, k)）', () => {
  it('≤6 人房（k=6 ≥ n-1）：期望值 = n-1，行為與改動前一致', () => {
    expect(bridgeExpectedPeers(2, { connected: 1, targetNeighbors: 6 })).toBe(1);
    expect(bridgeExpectedPeers(5, { connected: 4, targetNeighbors: 6 })).toBe(4);
    expect(bridgeExpectedPeers(6, { connected: 5, targetNeighbors: 6 })).toBe(5);
  });

  it('partial mesh（7+ 人，k<n-1）：期望值 = k，鄰居健全即不橋接（V5 核心）', () => {
    // 8 人房 k=3：連滿 3 個鄰居 → connected < expectedPeers 為假 → 不觸發備援雙寫
    const expected = bridgeExpectedPeers(8, { connected: 3, targetNeighbors: 3 });
    expect(expected).toBe(3);
    expect(3 < expected).toBe(false); // 不橋接
    // 鄰居劣化（2 < 3）才橋接——備援回歸例外路徑而非每訊息
    expect(2 < expected).toBe(true);
    // 10 人房 k=4 同理
    expect(bridgeExpectedPeers(10, { connected: 4, targetNeighbors: 4 })).toBe(4);
  });

  it('coverage 未透出 k（樁/舊版）：退回 n-1（＝舊行為，不誤縮）', () => {
    expect(bridgeExpectedPeers(8, { connected: 3 })).toBe(7);
  });
});

describe('useMeshHealth（Q5：connected/k 顯示與三態健康燈）', () => {
  it('partial mesh 房連滿 k → healthy；部分 → partial；全斷 → down', () => {
    const conn = ref('connected');
    const members = ref(8);
    const h = useMeshHealth(conn, members);

    h.updateCoverage({ connected: 3, targetNeighbors: 3 }, 8);
    expect(h.meshTarget.value).toBe(3); // min(7, 3)
    expect(h.meshHealth.value).toBe('healthy');
    expect(h.statusText.value).toBe('已連線 3/3');

    h.updateCoverage({ connected: 1, targetNeighbors: 3 }, 8);
    expect(h.meshHealth.value).toBe('partial');
    expect(h.statusText.value).toBe('已連線 1/3');

    h.updateCoverage({ connected: 0, targetNeighbors: 3 }, 8);
    expect(h.meshHealth.value).toBe('down');
  });

  it('2 人房維持純文字「已連線」（不顯示分數，行為不變）', () => {
    const conn = ref('connected');
    const members = ref(2);
    const h = useMeshHealth(conn, members);
    h.updateCoverage({ connected: 1, targetNeighbors: 6 }, 2);
    expect(h.statusText.value).toBe('已連線');
    expect(h.meshHealth.value).toBe('healthy'); // target=min(1,6)=1、connected=1
  });

  it('尚無其他成員/初始化中（target=0）：健康燈中性 partial，不誤報斷線', () => {
    const conn = ref('connecting');
    const members = ref(1);
    const h = useMeshHealth(conn, members);
    h.updateCoverage({ connected: 0, targetNeighbors: 6 }, 1);
    expect(h.meshHealth.value).toBe('partial');
    expect(h.statusText.value).toBe('連線中…');
  });
});
