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
    define: {
      // E2E 用開關：nuxt 的 vite env 只穩定讀 web-vue/.env*，process.env 的
      // VITE_* 不保證進 import.meta.env——曾因此讓 E2E 打到正式 Firebase。
      // 在 config 時間點顯式注入，杜絕環境歧義（見 src/config/firebase.ts）。
      'import.meta.env.VITE_USE_EMULATOR': JSON.stringify(process.env.VITE_USE_EMULATOR ?? 'false'),
      // LS 結帳連結（同 React 線 VITE_LS_CHECKOUT_URL）：未設定的環境升級鈕不顯示。
      'import.meta.env.VITE_LS_CHECKOUT_URL': JSON.stringify(process.env.VITE_LS_CHECKOUT_URL ?? ''),
    },
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
