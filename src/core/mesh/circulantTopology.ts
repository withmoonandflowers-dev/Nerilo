/**
 * 確定性互選拓撲（Spec 016）— partial mesh 鄰居目標集的純函式推導。
 *
 * 動機：一條 mesh 邊要成形，兩端都必須各自建立 MeshConnection（發起方由 uid 序
 * 裁決、應答方靠自己也把對方列為目標才會建物件收訊）。隨機選擇（舊 selectNeighbors）
 * 使互選純屬機率，未互選的 offer 無人接聽 → 逾時循環重連（7 人房實測 101 次發起
 * 僅 17 次成形）。改為兩端從同一名冊決定性推導同一邊集，互選由構造保證。
 *
 * 構造：名冊去重排序成環（circulant graph C_n(1..⌈k/2⌉)）。每節點的目標＝環上
 * 前後偏移 1..⌈k/2⌉ 的節點。性質：
 *  - 對稱：偏移集對負封閉 → b ∈ targets(a) ⟺ a ∈ targets(b)。
 *  - 連通：含偏移 1 的 circulant 圖必連通（環本身即 Hamiltonian cycle）。
 *  - 度數 ≤ 2⌈k/2⌉（k=3→4、k=4→4），有界且略高於 k，合「只升不降」精神。
 * full mesh 檔（k ≥ n-1）回傳全體其他人，行為與既有 ≤6 人房一致。
 *
 * 名冊視圖短暫分歧（晚到者傳播窗）期間兩端可能算出不同邊集 → 暫時單邊嘗試；
 * 由 discovery watch push 重算與入站 offer 應答（MeshTopologyManager）自癒。
 */

/**
 * 推導本節點的鄰居目標集。
 * @param rosterUserIds 名冊（mesh userId；應含自己，未含時視為 roster ∪ {self}）
 * @param selfUserId 本節點 userId
 * @param k 目標鄰居數（AdaptiveTopologyManager 決定；k ≥ n-1 即 full mesh）
 * @returns 目標 userId 陣列（字典序，不含自己）；決定性：同輸入必同輸出，
 *          與 rosterUserIds 的傳入順序無關。
 */
export function computeCirculantTargets(
  rosterUserIds: readonly string[],
  selfUserId: string,
  k: number
): string[] {
  const ring = [...new Set([...rosterUserIds, selfUserId])].sort();
  const n = ring.length;
  if (n <= 1 || k <= 0) return [];

  // full mesh 檔：k 蓋得住全體 → 全連（與既有 ≤6 人行為一致）
  if (k >= n - 1) return ring.filter((id) => id !== selfUserId);

  const i = ring.indexOf(selfUserId);
  const halfK = Math.ceil(k / 2);
  const targets = new Set<string>();
  for (let o = 1; o <= halfK; o++) {
    targets.add(ring[(i + o) % n]!);
    targets.add(ring[(i - o + n) % n]!);
  }
  targets.delete(selfUserId);
  return [...targets].sort();
}
