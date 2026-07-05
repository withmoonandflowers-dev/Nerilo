/**
 * 主題（light / dark / neo）：掛在 <html data-theme>，localStorage 持久化。
 * 預設 neo（產品負責人 2026-07-05 定調的前衛視覺方向）；
 * light 是 token 的 :root 基底、dark/neo 為覆蓋層（見 main.css）。
 */
export type ThemeName = 'light' | 'dark' | 'neo'

const STORAGE_KEY = 'nerilo_theme'
const ORDER: ThemeName[] = ['neo', 'light', 'dark']
const DEFAULT_THEME: ThemeName = 'neo'

const current = ref<ThemeName>(DEFAULT_THEME)

function apply(theme: ThemeName) {
  if (theme === 'light') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

export function useTheme() {
  const setTheme = (theme: ThemeName) => {
    current.value = theme
    apply(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* Safari 隱私模式等：不持久化也能用 */
    }
  }

  const initTheme = () => {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setTheme(ORDER.includes(saved as ThemeName) ? (saved as ThemeName) : DEFAULT_THEME)
  }

  const cycleTheme = () => {
    const idx = ORDER.indexOf(current.value)
    setTheme(ORDER[(idx + 1) % ORDER.length]!)
  }

  return { theme: readonly(current), setTheme, initTheme, cycleTheme }
}
