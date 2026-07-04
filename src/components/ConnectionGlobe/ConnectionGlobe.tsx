/**
 * 連線地球（cobe，WebGL 點陣地球，隱私優先時區近似定位）。
 *
 * 用 cobe（Vercel 出品，~32K）繪製精緻的點陣地球，以 markers 標出自己與對方
 * 的近似位置（時區推得，不碰 GPS/IP）。主題色感知（讀 CSS 變數）。
 * WebGL 不可用時優雅降級為不顯示（不影響聊天）。
 */
import { useEffect, useRef } from 'react';
import createGlobe from 'cobe';
import { useTheme } from '../../contexts/ThemeContext';
import type { LatLng } from '../../utils/geo';
import './ConnectionGlobe.css';

export interface GlobePoint {
  coord: LatLng;
  self?: boolean;
  label?: string;
}

interface ConnectionGlobeProps {
  points: GlobePoint[];
  size?: number;
}

/** 讀 CSS 變數（hex）→ cobe 需要的 [r,g,b]（0..1） */
function cssVarRgb(name: string, fallback: [number, number, number]): [number, number, number] {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = raw.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const int = parseInt(m[1], 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

export function ConnectionGlobe({ points, size = 220 }: ConnectionGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const phiRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dark = theme === 'dark' ? 1 : 0;
    const marker = cssVarRgb('--color-primary', [0.71, 0.51, 0.55]);
    const glow = cssVarRgb('--color-primary', [0.71, 0.51, 0.55]);
    // 點陣基色：淺主題用柔和暖白偏主色，深主題用主色
    const base: [number, number, number] = dark
      ? cssVarRgb('--color-primary', [0.72, 0.64, 0.85])
      : [0.86, 0.78, 0.78];

    const self = points.find((p) => p.self);
    const markers = points.map((p) => ({
      location: [p.coord.lat, p.coord.lng] as [number, number],
      size: p.self ? 0.09 : 0.06,
    }));
    // 自己 → 每位夥伴的連線弧（v2 cobe 原生支援）
    const arcs = self
      ? points
          .filter((p) => !p.self)
          .map((p) => ({
            from: [self.coord.lat, self.coord.lng] as [number, number],
            to: [p.coord.lat, p.coord.lng] as [number, number],
          }))
      : [];

    let globe: import('cobe').Globe | null = null;
    let raf = 0;
    try {
      globe = createGlobe(canvas, {
        devicePixelRatio: dpr,
        width: size * dpr,
        height: size * dpr,
        phi: phiRef.current,
        theta: 0.28,
        dark,
        diffuse: 1.2,
        mapSamples: 14000,
        mapBrightness: dark ? 5 : 8,
        baseColor: base,
        markerColor: marker,
        glowColor: glow,
        markers,
        arcs,
        arcColor: marker,
        arcWidth: 1.4,
      });
      const g = globe;
      const tick = () => {
        phiRef.current += 0.004;
        g.update({ phi: phiRef.current });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch {
      // WebGL 不可用 → 靜默降級（不影響聊天）
      globe = null;
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      globe?.destroy();
    };
    // points 內容變化時重建（peer 加入）；主題變化時換色
  }, [points, size, theme]);

  return (
    <div className="connection-globe" aria-hidden="true">
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, aspectRatio: '1' }}
        className="connection-globe-canvas"
      />
    </div>
  );
}
