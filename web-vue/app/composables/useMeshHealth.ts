/**
 * mesh 覆蓋率與連線狀態顯示（Spec 011 Q4/Q5）。
 *
 * - target = min(n-1, 拓撲目標鄰居數 k)：partial mesh（7+ 人）下 k < n-1 是設計，
 *   顯示或橋接沿用 n-1 會「永遠未連滿」誤導使用者、每訊息觸發備援雙寫。
 *   ≤6 人房 k=6 ≥ n-1，min 取 n-1，行為與 Spec 011 之前完全一致。
 * - 健康燈三態：healthy（connected ≥ target）／partial（部分連上或初始化中）／down（全斷）。
 *
 * 獨立成 composable 的原因：chat/[roomId].vue 受 god-file 行數棘輪管制，
 * 新功能進新檔（比照 lib/gameRoomFlag 抽出前例）。
 */
import { ref, computed, type Ref } from 'vue'

export type ConnectionStateText = 'connecting' | 'connected' | 'failed' | 'closed'

export interface MeshCoverageLike {
  connected: number
  targetNeighbors?: number
}

/** 橋接期望值（Q4b）：min(n-1, k)。coverage 未透出 k（樁/舊版）→ 退回 n-1（＝舊行為）。 */
export function bridgeExpectedPeers(participantCount: number, coverage: MeshCoverageLike): number {
  return Math.min(participantCount - 1, coverage.targetNeighbors ?? Infinity)
}

export function useMeshHealth(connectionState: Ref<string>, memberCount: Ref<number>) {
  const meshConnected = ref(0)
  const meshTarget = ref(0)

  const meshHealth = computed<'healthy' | 'partial' | 'down'>(() => {
    if (meshTarget.value <= 0) return 'partial' // 尚無其他成員/初始化中：中性顯示
    if (meshConnected.value >= meshTarget.value) return 'healthy'
    return meshConnected.value > 0 ? 'partial' : 'down'
  })

  /** 連線狀態列文案；3+ 人 mesh 房在已連線時附 connected/target（Q5a） */
  const statusText = computed(() => {
    switch (connectionState.value) {
      case 'connected':
        return memberCount.value > 2 && meshTarget.value > 0
          ? `已連線 ${meshConnected.value}/${meshTarget.value}`
          : '已連線'
      case 'connecting':
        return '連線中…'
      case 'failed':
        return '連線失敗'
      case 'closed':
        return '連線已中斷'
      default:
        return '準備中…'
    }
  })

  /** 由連線輪詢餵入最新覆蓋率（getMeshCoverage()）與房間人數 */
  function updateCoverage(coverage: MeshCoverageLike, participantCount: number): void {
    meshConnected.value = coverage.connected
    meshTarget.value = Math.min(
      Math.max(participantCount - 1, 0),
      coverage.targetNeighbors ?? Infinity
    )
  }

  return { meshConnected, meshTarget, meshHealth, statusText, updateCoverage }
}
