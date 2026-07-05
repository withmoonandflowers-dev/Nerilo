<script setup lang="ts">
/**
 * Landing（G4「第一眼衝擊」的正確載體，與工具頁分離）：
 * 地球 hero + 大字標語 + 三張價值卡。重資產只有 cobe（client-only、~5KB gzip）。
 */
import { localTimezone, timezoneToLatLng } from '@legacy/utils/geo'

const self = { coord: timezoneToLatLng(localTimezone()), self: true }
// 示意連線點（裝飾用途的固定城市，不代表真實 peer）
const demoPeers = [
  { coord: { lat: 35.68, lng: 139.69 } }, // 東京
  { coord: { lat: 37.77, lng: -122.42 } }, // 舊金山
  { coord: { lat: 51.5, lng: -0.12 } }, // 倫敦
  { coord: { lat: -33.87, lng: 151.21 } }, // 雪梨
]
const points = [self, ...demoPeers]

const features = [
  {
    icon: '🔒',
    title: '端對端加密',
    body: 'ECDH 金鑰交換 + AES-256-GCM。訊息在你的裝置加密，只有對方能解開。',
  },
  {
    icon: '↔️',
    title: '點對點直達',
    body: 'WebRTC 直連，訊息不經過伺服器——沒有人能在中途讀取或儲存。',
  },
  {
    icon: '🛟',
    title: '斷了也不掉',
    body: 'P2P 中斷時自動切換備援通道，維持同等加密，對話不中斷。',
  },
]
</script>

<template>
  <main class="landing">
    <section class="hero">
      <div class="hero__globe stagger" style="--i: 0">
        <ConnectionGlobe :points="points" :size="300" :speed="0.6" />
      </div>
      <h1 class="hero__title stagger" style="--i: 2">訊息不經過伺服器</h1>
      <p class="hero__sub stagger" style="--i: 3">
        Nerilo 把你的訊息點對點直送對方裝置——端對端加密、零伺服器儲存。
      </p>
      <div class="hero__cta stagger" style="--i: 4">
        <NuxtLink to="/dashboard" class="btn-primary hero__cta-main">開始聊天</NuxtLink>
        <NuxtLink to="/login" class="hero__cta-sub">登入帳號</NuxtLink>
      </div>
    </section>

    <section class="features">
      <article v-for="(f, i) in features" :key="f.title" class="feature card stagger" :style="{ '--i': i + 5 }">
        <span class="feature__icon">{{ f.icon }}</span>
        <h2 class="feature__title">{{ f.title }}</h2>
        <p class="feature__body">{{ f.body }}</p>
      </article>
    </section>

    <footer class="landing__footer">
      <span>Nerilo — P2P 資料傳遞架構的第一個參考應用</span>
    </footer>
  </main>
</template>

<style scoped>
.landing {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: calc(env(safe-area-inset-top, 0px) + 40px) 24px 32px;
}
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 560px;
}
.hero__globe {
  /* 地球光暈：唯一允許的「戲劇性」元素，工具頁禁用（規格禁止事項仍成立） */
  filter: drop-shadow(0 0 48px rgba(10, 132, 255, 0.25));
}
.hero__title {
  margin: 28px 0 0;
  font-size: clamp(32px, 7vw, 48px);
  font-weight: 800;
  letter-spacing: -1px;
  line-height: 1.15;
}
.hero__sub {
  margin: 14px 0 0;
  font-size: 17px;
  line-height: 1.55;
  color: var(--text-2);
  max-width: 400px;
}
.hero__cta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: 28px;
  width: min(280px, 100%);
}
.hero__cta-main { text-decoration: none; }
.hero__cta-sub {
  font-size: 15px;
  font-weight: 500;
  color: var(--primary);
  text-decoration: none;
}
.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  max-width: 860px;
  width: 100%;
  margin-top: 64px;
}
.feature {
  padding: 24px 20px;
  text-align: left;
}
.feature__icon { font-size: 28px; }
.feature__title { margin: 12px 0 6px; font-size: 17px; font-weight: 700; }
.feature__body { margin: 0; font-size: 14px; line-height: 1.55; color: var(--text-2); }
.landing__footer {
  margin-top: 64px;
  font-size: 13px;
  color: var(--text-3);
}
</style>
