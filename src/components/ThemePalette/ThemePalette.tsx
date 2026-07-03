/**
 * 調色盤切換器 — 右下角浮動按鈕，展開後可即時切換五組主題。
 * 選擇立即套用（見 ThemeContext），並記憶於 localStorage。
 */
import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { featureLog } from '../../utils/featureLog';
import './ThemePalette.css';

export function ThemePalette() {
  const { theme, setTheme, themes } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 點外部收合
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = themes.find((t) => t.id === theme) ?? themes[0];

  return (
    <div className="theme-palette" ref={rootRef}>
      {open && (
        <div className="theme-palette-menu" role="listbox" aria-label="選擇調色盤">
          <div className="theme-palette-title">調色盤</div>
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={t.id === theme}
              className={`theme-palette-item${t.id === theme ? ' is-active' : ''}`}
              onClick={() => {
                setTheme(t.id);
                featureLog('dashboard', 'theme_change', { theme: t.id });
              }}
            >
              <span className="theme-swatches" aria-hidden="true">
                {t.swatches.map((c, i) => (
                  <span key={i} className="theme-swatch" style={{ background: c }} />
                ))}
              </span>
              <span className="theme-palette-label">{t.label}</span>
              {t.id === theme && (
                <span className="theme-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="theme-palette-toggle"
        aria-label={open ? '收合調色盤' : `切換調色盤，目前：${current.label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="theme-toggle-swatches" aria-hidden="true">
          {current.swatches.map((c, i) => (
            <span key={i} className="theme-toggle-dot" style={{ background: c }} />
          ))}
        </span>
      </button>
    </div>
  );
}
