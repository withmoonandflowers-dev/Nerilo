<script setup lang="ts">
/**
 * 連線地球（cobe v2 WebGL）
 *
 * 訊號傳遞動感（2026-07-05 產品決策）：不只畫連線弧——
 * - 「封包」marker 沿大圓從節點滑向節點（slerp 插值），抵達時端點脈衝一下；
 * - 單節點（沒有 peers）時自身呼吸脈衝，空狀態也有生命感；
 * - 可觸碰拖曳旋轉（pointer 事件 + 慣性衰減），拖曳時暫停自轉。
 * 位置仍是時區近似（不碰 GPS/IP）；prefers-reduced-motion 時停用動畫、保留拖曳。
 * WebGL 不可用靜默降級。
 */
import createGlobe from 'cobe'
import type { LatLng } from '@legacy/utils/geo'

export interface GlobePoint {
  coord: LatLng
  self?: boolean
}

const props = withDefaults(
  defineProps<{
    points: GlobePoint[]
    size?: number
    /** 每秒自轉弧度的倍率，landing 用慢一點更沉穩 */
    speed?: number
  }>(),
  { size: 220, speed: 1 }
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let globe: ReturnType<typeof createGlobe> | null = null
let raf = 0
let phi = 0

const PRIMARY: [number, number, number] = [10 / 255, 132 / 255, 255 / 255]
const NEO_PINK: [number, number, number] = [255 / 255, 45 / 255, 138 / 255]
const NEO_LIME: [number, number, number] = [200 / 255, 255 / 255, 61 / 255]
const BASE_LIGHT: [number, number, number] = [0.78, 0.82, 0.88]

// ── 大圓插值（訊號封包的軌跡）─────────────────────────────────────────
type V3 = [number, number, number]
function toVec([lat, lng]: [number, number]): V3 {
  const la = (lat * Math.PI) / 180
  const lo = (lng * Math.PI) / 180
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
}
function toLatLng(v: V3): [number, number] {
  const [x, y, z] = v
  return [(Math.asin(z) * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI]
}
/** 球面線性插值：封包沿大圓走（直線插值會鑽進地心） */
function slerp(a: V3, b: V3, t: number): V3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const omega = Math.acos(dot)
  if (omega < 1e-6) return a
  const so = Math.sin(omega)
  const ka = Math.sin((1 - t) * omega) / so
  const kb = Math.sin(t * omega) / so
  return [ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2]]
}
/** 平滑起停（封包加速/減速的手感） */
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

interface Packet {
  from: [number, number]
  to: [number, number]
  start: number
  duration: number
}

// ── 拖曳旋轉 ─────────────────────────────────────────────────────────
let dragging = false
let lastX = 0
let velocity = 0
let phiOffset = 0

function onPointerDown(e: PointerEvent) {
  dragging = true
  lastX = e.clientX
  velocity = 0
  ;(e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  const dx = e.clientX - lastX
  lastX = e.clientX
  phiOffset += dx * 0.006
  velocity = dx * 0.006
}
function onPointerUp() {
  dragging = false
}

function build() {
  destroy()
  const canvas = canvasEl.value
  if (!canvas) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  // cobe/phenomenon 不設 canvas buffer 尺寸，不自己設會停在預設 300×150 而畫不出來
  canvas.width = props.size * dpr
  canvas.height = props.size * dpr
  const themeAttr = document.documentElement.dataset.theme
  const dark = themeAttr === 'dark' || themeAttr === 'neo' ? 1 : 0
  const isNeo = themeAttr === 'neo'
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const accent = isNeo ? NEO_PINK : PRIMARY
  const packetColor = isNeo ? NEO_LIME : PRIMARY

  const self = props.points.find((p) => p.self)
  const baseMarkers = props.points.map((p) => ({
    location: [p.coord.lat, p.coord.lng] as [number, number],
    size: p.self ? 0.09 : 0.06,
  }))
  const routes: Array<{ from: [number, number]; to: [number, number] }> = self
    ? props.points
        .filter((p) => !p.self)
        .map((p) => ({
          from: [self.coord.lat, self.coord.lng] as [number, number],
          to: [p.coord.lat, p.coord.lng] as [number, number],
        }))
    : []
  const arcs = routes.map((r) => ({ from: r.from, to: r.to }))

  try {
    globe = createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: props.size * dpr,
      height: props.size * dpr,
      phi,
      theta: 0.28,
      dark,
      diffuse: 1.2,
      mapSamples: 14000,
      mapBrightness: dark ? 5 : 8,
      baseColor: dark ? accent : BASE_LIGHT,
      markerColor: accent,
      glowColor: dark ? accent : [1, 1, 1],
      markers: baseMarkers,
      arcs,
      arcColor: accent,
      arcWidth: 1.4,
    })

    // ── 動畫主迴圈：自轉 + 拖曳/慣性 + 訊號封包 ──────────────────────
    const packets: Packet[] = []
    let nextSpawn = performance.now() + 900

    const tick = (now: number) => {
      // 旋轉：拖曳優先；放手後慣性衰減；靜止時回到自轉
      if (!dragging) {
        velocity *= 0.95
        phiOffset += velocity
        if (!reduceMotion && Math.abs(velocity) < 0.001) phi += 0.004 * props.speed
      }

      const markers = [...baseMarkers]

      if (!reduceMotion) {
        // 產生封包：有路徑走隨機路徑；單節點則原地呼吸
        if (now >= nextSpawn) {
          nextSpawn = now + 1100 + Math.random() * 1400
          if (routes.length > 0) {
            const r = routes[Math.floor(Math.random() * routes.length)]!
            // 方向隨機（傳出/收到都有）
            const flip = Math.random() < 0.5
            packets.push({
              from: flip ? r.to : r.from,
              to: flip ? r.from : r.to,
              start: now,
              duration: 1500,
            })
          }
        }

        // 推進封包：沿大圓移動；末段在終點放大脈衝後消散
        for (let i = packets.length - 1; i >= 0; i--) {
          const p = packets[i]!
          const t = (now - p.start) / p.duration
          if (t >= 1.35) {
            packets.splice(i, 1)
            continue
          }
          if (t < 1) {
            const pos = toLatLng(slerp(toVec(p.from), toVec(p.to), easeInOut(t)))
            markers.push({ location: pos, size: 0.028, color: packetColor } as never)
          } else {
            // 抵達脈衝：0.35 的尾巴放大再淡出（以 size 模擬）
            const k = (t - 1) / 0.35
            markers.push({
              location: p.to,
              size: 0.05 + 0.07 * (1 - k),
              color: packetColor,
            } as never)
          }
        }

        // 單節點呼吸（空狀態的生命感）
        if (routes.length === 0 && self) {
          const breath = 0.09 + 0.025 * (0.5 + 0.5 * Math.sin(now / 600))
          markers[markers.indexOf(baseMarkers[0]!)] = {
            location: [self.coord.lat, self.coord.lng],
            size: breath,
          }
        }
      }

      globe?.update({ phi: phi + phiOffset, markers })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  } catch (e) {
    console.warn('[ConnectionGlobe] createGlobe failed, degrading silently', e)
    globe = null // WebGL 不可用 → 靜默降級
  }
}

function destroy() {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  globe?.destroy()
  globe = null
}

// Nuxt .client 元件的已知特性：onMounted 時 template ref 可能尚未就緒，
// 改 watch ref 出現才 build（涵蓋首掛與 re-mount 兩種時序）。
watch(canvasEl, (c) => {
  if (c) build()
})
onMounted(() => {
  if (canvasEl.value) build()
})
watch(() => [props.points, props.size], build, { deep: true })
onUnmounted(destroy)
</script>

<template>
  <div class="globe">
    <canvas
      ref="canvasEl"
      :style="{ width: `${size}px`, height: `${size}px`, aspectRatio: '1' }"
      aria-label="連線地球（可拖曳旋轉）"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    />
  </div>
</template>

<style scoped>
.globe {
  display: flex;
  justify-content: center;
}
.globe canvas {
  display: block;
  contain: layout paint size;
  touch-action: none; /* 拖曳旋轉優先於頁面捲動 */
  cursor: grab;
}
.globe canvas:active {
  cursor: grabbing;
}
</style>
