/**
 * 連線地球動畫（隱私優先，時區近似定位）。
 *
 * 輕量 canvas 2D：自轉的經緯球 + 自己/對方的發光座標點 + 連線弧線。
 * 刻意不用 three.js（bundle 與 GPU 成本高）；經緯球以正交投影繪製，
 * 位置點對映時區推得的近似經緯度。主題色感知（讀 CSS 變數）。
 */
import { useEffect, useRef } from 'react';
import { projectOrthographic, type LatLng } from '../../utils/geo';
import './ConnectionGlobe.css';

export interface GlobePoint {
  coord: LatLng;
  /** 是否為本機（自己） */
  self?: boolean;
  label?: string;
}

interface ConnectionGlobeProps {
  points: GlobePoint[];
  /** 畫布邊長（正方形），預設 200 */
  size?: number;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function ConnectionGlobe({ points, size = 200 }: ConnectionGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 10;

    // 主題色（點陣/弧線/光點），啟動時讀一次
    const primary = cssVar('--color-primary', '#b5838d');
    const accent = cssVar('--color-accent', '#a5a58d');

    let raf = 0;
    let rotation = 0;
    let arcPhase = 0;
    let t = 0;
    let stopped = false;

    // 畫一條由經緯點構成的弧（僅連接正面可見的連續段）
    const strokePath = (pts: LatLng[]) => {
      ctx.beginPath();
      let started = false;
      for (const pt of pts) {
        const p = projectOrthographic(pt, cx, cy, r, rotation);
        if (p.visible) {
          if (started) ctx.lineTo(p.x, p.y);
          else {
            ctx.moveTo(p.x, p.y);
            started = true;
          }
        } else {
          started = false;
        }
      }
      ctx.stroke();
    };

    const draw = () => {
      if (stopped) return;
      ctx.clearRect(0, 0, size, size);

      // 球體光暈
      const glow = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r * 1.18);
      glow.addColorStop(0, primary + '33');
      glow.addColorStop(0.7, primary + '14');
      glow.addColorStop(1, primary + '00');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.18, 0, Math.PI * 2);
      ctx.fill();

      // 球面底色
      ctx.fillStyle = primary + '0e';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // 球體外圈
      ctx.strokeStyle = primary;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // 經線圈（子午線）：每 30°
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.28;
      for (let lng = -180; lng < 180; lng += 30) {
        const meridian: LatLng[] = [];
        for (let lat = -90; lat <= 90; lat += 5) meridian.push({ lat, lng });
        strokePath(meridian);
      }
      // 緯線圈：每 30°
      for (let lat = -60; lat <= 60; lat += 30) {
        const parallel: LatLng[] = [];
        for (let lng = -180; lng <= 180; lng += 5) parallel.push({ lat, lng });
        strokePath(parallel);
      }
      ctx.globalAlpha = 1;

      // 連線弧線：本機 → 其他每個點
      const pts = pointsRef.current;
      const self = pts.find((p) => p.self);
      if (self) {
        const a = projectOrthographic(self.coord, cx, cy, r, rotation);
        for (const other of pts) {
          if (other.self) continue;
          const b = projectOrthographic(other.coord, cx, cy, r, rotation);
          // 弧的控制點：兩點中點往外推，形成飛越感
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const ox = mx - cx;
          const oy = my - cy;
          const olen = Math.hypot(ox, oy) || 1;
          const lift = r * 0.5;
          const ctrlX = mx + (ox / olen) * lift;
          const ctrlY = my + (oy / olen) * lift;

          ctx.strokeStyle = primary;
          ctx.globalAlpha = a.visible || b.visible ? 0.75 : 0.25;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(ctrlX, ctrlY, b.x, b.y);
          ctx.stroke();

          // 沿弧線流動的光點（拖尾，更明顯）
          for (let k = 0; k < 3; k++) {
            const tp = (arcPhase - k * 0.06 + 1) % 1;
            const qx = (1 - tp) * (1 - tp) * a.x + 2 * (1 - tp) * tp * ctrlX + tp * tp * b.x;
            const qy = (1 - tp) * (1 - tp) * a.y + 2 * (1 - tp) * tp * ctrlY + tp * tp * b.y;
            ctx.globalAlpha = 0.9 - k * 0.28;
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.arc(qx, qy, 3.5 - k, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;

      // 座標光點（自己較亮較大，帶脈衝環）
      const pulse = (Math.sin(t * 2.2) + 1) / 2; // 0..1
      for (const pt of pts) {
        const p = projectOrthographic(pt.coord, cx, cy, r, rotation);
        if (!p.visible) continue;
        const color = pt.self ? primary : accent;
        const radius = pt.self ? 5 : 4.5;
        // 脈衝環（擴散）
        ctx.globalAlpha = 0.35 * (1 - pulse);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 3 + pulse * 7, 0, Math.PI * 2);
        ctx.stroke();
        // 外圈光暈
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius * 2.1, 0, Math.PI * 2);
        ctx.fill();
        // 實心點
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        // 白心
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      rotation = (rotation + 0.22) % 360;
      arcPhase = (arcPhase + 0.012) % 1;
      t += 0.016;
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [size]);

  return (
    <div className="connection-globe" aria-hidden="true">
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        className="connection-globe-canvas"
      />
    </div>
  );
}
