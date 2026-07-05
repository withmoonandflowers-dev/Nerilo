/**
 * 確定性視覺雜湊：同一個 id 永遠得到同一組漸層色。
 * 解「每列頭像都一樣」的單調問題（G1 內容豐富感），零資料成本。
 */

function hash(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h
}

/** id → CSS 線性漸層。色相由 hash 決定，飽和/明度鎖在柔和區間（不刺眼、白字可讀） */
export function gradientFor(id: string): string {
  const h1 = hash(id) % 360
  const h2 = (h1 + 40 + (hash(id + '#') % 50)) % 360
  return `linear-gradient(135deg, hsl(${h1} 70% 62%), hsl(${h2} 72% 52%))`
}

/** uid → 頭像顯示字（去掉 device 後綴，取第一個字元大寫） */
export function initialFor(name: string | undefined, fallback = '?'): string {
  const c = (name ?? '').trim().charAt(0)
  return c ? c.toUpperCase() : fallback
}
