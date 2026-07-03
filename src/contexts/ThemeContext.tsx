/**
 * 主題（調色盤）Context。
 *
 * 五組可切換主題，寫入 documentElement 的 data-theme，全站 CSS token 即時生效。
 * 選擇記憶於 localStorage；預設「柔霧莫蘭迪」。
 */
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

export type ThemeId = 'morandi' | 'cream' | 'lavender' | 'forest' | 'dark';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  /** 三色票（primary / accent / surface），供調色盤預覽 */
  swatches: [string, string, string];
}

/** 調色盤清單（順序即 UI 顯示順序），色票對齊 variables.css */
export const THEMES: ThemeMeta[] = [
  { id: 'morandi', label: '柔霧莫蘭迪', swatches: ['#b5838d', '#a5a58d', '#f3ece7'] },
  { id: 'cream', label: '奶油甜柔', swatches: ['#e58a72', '#c9a0dc', '#fff7f0'] },
  { id: 'lavender', label: '薰衣草夢幻', swatches: ['#9d8df1', '#a0c4ff', '#f5f3ff'] },
  { id: 'forest', label: '森林療癒', swatches: ['#6b7f52', '#e9c46a', '#f4f3ec'] },
  { id: 'dark', label: '沉靜夜幕', swatches: ['#b8a3d9', '#a0c4ff', '#1c1b24'] },
];

const STORAGE_KEY = 'nerilo-theme';
const DEFAULT_THEME: ThemeId = 'morandi';

function isValidTheme(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isValidTheme(stored)) return stored;
  } catch {
    // localStorage 不可用（無痕）→ 用預設
  }
  return DEFAULT_THEME;
}

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  themes: ThemeMeta[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  // 套用到 documentElement，並持久化
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 無痕模式：僅套用不持久化
    }
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    if (isValidTheme(id)) setThemeState(id);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
