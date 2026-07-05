<script setup lang="ts">
const { initTheme } = useTheme()
onMounted(initTheme)
</script>

<template>
  <div class="app-root">
    <NuxtPage />
    <ToastHost />
  </div>
</template>

<style scoped>
.app-root {
  height: 100%;
}
</style>
