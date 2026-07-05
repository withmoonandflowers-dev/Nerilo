<script setup lang="ts">
const { initTheme } = useTheme()
onMounted(initTheme)

// 頁間 navigate 的 loading：SPA 深層路由/async setup 時內容區會短暫空白，
// 顯示品牌 loading 取代白屏（頂部進度條 + 首屏 splash 見 spa-loading-template）。
const routeLoading = ref(false)
const nuxtApp = useNuxtApp()
let hideTimer: ReturnType<typeof setTimeout> | null = null
nuxtApp.hook('page:start', () => {
  if (hideTimer) clearTimeout(hideTimer)
  routeLoading.value = true
})
nuxtApp.hook('page:finish', () => {
  // 稍延遲收起，避免極快切換時閃一下
  hideTimer = setTimeout(() => (routeLoading.value = false), 120)
})
</script>

<template>
  <div class="app-root">
    <div class="route-bar" :class="{ 'route-bar--on': routeLoading }" />
    <NuxtPage />
    <ToastHost />
  </div>
</template>

<style scoped>
.app-root {
  height: 100%;
}
/* 頂部漸層進度條（neo）：navigate 期間滑入，取代整頁白屏的焦慮感 */
.route-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2.5px;
  z-index: 999;
  background: linear-gradient(90deg, #FF2D8A, #8B5CF6);
  transform: scaleX(0);
  transform-origin: left;
  opacity: 0;
  transition: transform 0.6s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.2s;
}
.route-bar--on {
  transform: scaleX(0.85);
  opacity: 1;
}
</style>
