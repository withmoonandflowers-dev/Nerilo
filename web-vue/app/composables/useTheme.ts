/**
 * 主題（Spec 006 T1：單一乾淨主題＋深淺自動）。
 *
 * 跟隨系統 prefers-color-scheme 自動 light/dark，無手動循環、無持久化——
 * 2026-07-17 拍板，取代 2026-07-05「預設 neo」定調。neo tokens 保留在 main.css
 * 作 data-theme 覆蓋層（design/neo.vue 展示頁仍可 setTheme('neo') 預覽，無導覽入口）。
 *
 * light＝token 的 :root 基底、dark/neo＝覆蓋層（見 main.css）。
 */
export type ThemeName = 'light' | 'dark' | 'neo'

const current = ref<ThemeName>('light')
let mediaCleanup: (() => void) | null = null

function apply(theme: ThemeName) {
  if (theme === 'light') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

export function useTheme() {
  /** 手動指定（僅 design 展示頁預覽用；一般流程走 initTheme 的系統自動） */
  const setTheme = (theme: ThemeName) => {
    current.value = theme
    apply(theme)
  }

  /** 跟隨系統深淺：init 套用當下偏好並監聽系統切換（即時跟隨） */
  const initTheme = () => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystem = () => setTheme(mq.matches ? 'dark' : 'light')
    applySystem()
    mediaCleanup?.() // HMR/重複 init 防重掛
    mq.addEventListener('change', applySystem)
    mediaCleanup = () => mq.removeEventListener('change', applySystem)
  }

  return { theme: readonly(current), setTheme, initTheme }
}
