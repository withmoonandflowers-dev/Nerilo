<script setup lang="ts">
/**
 * 連線地球（cobe WebGL）— 移植自 React 版 src/components/ConnectionGlobe，
 * 邏輯相同：時區近似定位（不碰 GPS/IP）、markers + 原生 arcs、WebGL 不可用靜默降級。
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

const PRIMARY: [number, number, number] = [10 / 255, 132 / 255, 255 / 255] // --primary #0A84FF
const BASE_LIGHT: [number, number, number] = [0.78, 0.82, 0.88]

function build() {
  destroy()
  const canvas = canvasEl.value
  if (!canvas) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  // cobe/phenomenon 不設 canvas buffer 尺寸，不自己設會停在預設 300×150 而畫不出來
  canvas.width = props.size * dpr
  canvas.height = props.size * dpr
  const dark = document.documentElement.dataset.theme === 'dark' ? 1 : 0
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const self = props.points.find((p) => p.self)
  const markers = props.points.map((p) => ({
    location: [p.coord.lat, p.coord.lng] as [number, number],
    size: p.self ? 0.09 : 0.06,
  }))
  const arcs = self
    ? props.points
        .filter((p) => !p.self)
        .map((p) => ({
          from: [self.coord.lat, self.coord.lng] as [number, number],
          to: [p.coord.lat, p.coord.lng] as [number, number],
        }))
    : []

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
      baseColor: dark ? PRIMARY : BASE_LIGHT,
      markerColor: PRIMARY,
      glowColor: dark ? PRIMARY : [1, 1, 1],
      markers,
      arcs,
      arcColor: PRIMARY,
      arcWidth: 1.4,
    })
    if (!reduceMotion) {
      const tick = () => {
        phi += 0.004 * props.speed
        globe?.update({ phi })
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }
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
// 改watch ref 出現才 build（涵蓋首掛與 re-mount 兩種時序）。
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
  <div class="globe" aria-hidden="true">
    <canvas ref="canvasEl" :style="{ width: `${size}px`, height: `${size}px`, aspectRatio: '1' }" />
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
}
</style>
