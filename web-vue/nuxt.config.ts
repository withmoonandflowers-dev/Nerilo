import { fileURLToPath } from 'node:url'

// UI 重寫版（ADR-0017）：SPA 模式，複用 ../src 的框架無關核心（core/services/types/utils）
// nuxt 釘死 4.4.2（package.json 無 ^）：4.4.4 與 4.4.5 的 dev server 對 ssr:false 均有
// regression（nuxt/nuxt#34957、#35033），升版前先確認已修復。
export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  app: {
    pageTransition: { name: 'page', mode: 'out-in' },
    head: {
      title: 'Nerilo',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1.0, viewport-fit=cover' },
        { name: 'theme-color', content: '#F2F2F7' },
      ],
    },
  },
  alias: {
    '@legacy': fileURLToPath(new URL('../src', import.meta.url)),
  },
  vite: {
    resolve: {
      // ../src 的複用模組會就近解析到 Nerilo/node_modules 的 firebase 副本，
      // 與 web-vue 自己的副本形成兩個 @firebase/app 實例（auth 註冊不互通）。
      // dedupe 強制全部走 web-vue/node_modules 的單一副本。
      dedupe: ['firebase', '@firebase/app', '@firebase/auth', '@firebase/firestore', '@firebase/util', '@firebase/component', 'dexie', 'uuid'],
    },
  },
  typescript: {
    typeCheck: false,
  },
})
