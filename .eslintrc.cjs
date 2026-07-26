module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
  },
  overrides: [
    {
      // Test files frequently use `any` for partial mocks, stub services,
      // and casts from real types to test fixtures. Enforcing the rule
      // there buries real product-code issues under noise from legitimate
      // test-only `any` usage. Product code (src/) still warns on `any`.
      files: ['tests/**/*.ts', 'tests/**/*.tsx'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // Node 環境腳本（報告產生器等）：使用 process、node: 內建模組。
      files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
      env: { node: true, browser: false },
    },
    {
      // ── 前後端合約邊界 + 死重圍籬（機器強制）──────────────────────────
      // (1) 後端（core/services）不得依賴前端框架或 UI 層。依賴方向必須單向：
      //     前端 → 後端，後端永不 → 前端。保證 UI 可獨立換皮/重寫而不觸碰後端。
      //     詳見 docs/architecture/frontend-backend-contract.md。
      // (2) 死重圍籬（ADR-0031）：不得 import 已 PARK 的休眠模組。這些模組測過但
      //     沒接進產品流，凍結中；要解凍＝從本名單移除該路徑 + 更新 ADR-0031，
      //     是有意識的決定。excludedFiles 讓 PARK 模組自身仍可內部互 import。
      //     src/sdk 另有專屬區塊（見檔尾，Spec 013）：ESLint override 後者覆寫前者，
      //     同一條規則不能拆兩處寫，否則後面的會把前面的整組蓋掉。
      files: ['src/core/**/*.ts', 'src/services/**/*.ts'],
      excludedFiles: [
        '**/*.spec.ts',
        '**/*.test.ts',
        // PARK 模組自身不受圍籬（凍結原狀，非改動）
        'src/core/community/**',
        'src/core/game/**',
        'src/core/transport/**',
        'src/core/chain/**',
        'src/core/ledger/**',
        'src/core/protocol/**',
        'src/core/features/**',
        'src/core/relay/onion/**',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'react', message: '後端不得依賴 React（前後端合約，改用純 TS）。' },
              { name: 'react-dom', message: '後端不得依賴 React（前後端合約）。' },
              { name: 'vue', message: '後端不得依賴 Vue（前後端合約，須框架無關）。' },
            ],
            patterns: [
              {
                group: [
                  '**/features/**',
                  '**/pages/**',
                  '**/components/**',
                  '**/hooks/**',
                  '**/contexts/**',
                ],
                message: '後端不得依賴前端 UI 層（前後端合約，方向須為前端→後端）。',
              },
              {
                group: [
                  // 別名路徑（@/core/... 與 src/core/... 深層相對）
                  '**/core/community/**',
                  '**/core/game/**',
                  '**/core/transport/**',
                  '**/core/chain/**',
                  '**/core/ledger/**',
                  '**/core/protocol/**',
                  '**/core/features/**',
                  '**/core/relay/onion/**',
                  // ⚠ 相對路徑同樣要列（2026-07-26 實測發現的圍籬漏洞）：
                  // no-restricted-imports 比對的是「import 字串」不是解析後的路徑，
                  // 而 docs/DEVELOPMENT.md 慣例要求 core 模組用相對路徑 → `../game/X` 完全繞過
                  // 上面那組 `**/core/game/**`。圍籬自 2026-07-16 立起後，在它最該生效的
                  // core→core 方向上一直是裝飾品。
                  // 只放在本區塊：在 src/features 底下 `../game/` 指的是「活著的」
                  // features/game 薄層（ADR-0015），列進去會誤擋。探針：tests/unit/fitness.fence.spec.ts。
                  '../community/**', '../../community/**',
                  '../game/**', '../../game/**',
                  '../transport/**', '../../transport/**',
                  '../chain/**', '../../chain/**',
                  '../ledger/**', '../../ledger/**',
                  '../protocol/**', '../../protocol/**',
                  '../features/**', '../../features/**',
                  './onion/**', '../relay/onion/**', '../../relay/onion/**',
                ],
                message: '此模組已 PARK（休眠，ADR-0031），不得新接線。要解凍請改 ADR-0031 + 移除圍籬。',
              },
            ],
          },
        ],
      },
    },
    {
      // 死重圍籬（產品層）：features/pages 亦不得 import PARK 模組（ADR-0031）。
      // sdk 移到下一個區塊統一管（它還要多擋 UI 層）。
      files: ['src/features/**/*.ts', 'src/features/**/*.tsx', 'src/pages/**/*.tsx'],
      excludedFiles: ['**/*.spec.ts', '**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  // 別名路徑（@/core/... 與 src/core/... 深層相對）
                  '**/core/community/**',
                  '**/core/game/**',
                  '**/core/transport/**',
                  '**/core/chain/**',
                  '**/core/ledger/**',
                  '**/core/protocol/**',
                  '**/core/features/**',
                  '**/core/relay/onion/**',
                ],
                message: '此模組已 PARK（休眠，ADR-0031），不得新接線。要解凍請改 ADR-0031 + 移除圍籬。',
              },
            ],
          },
        ],
      },
    },
    {
      // ── SDK 公開契約圍籬（Spec 013）────────────────────────────────────
      // 公開契約不得相依應用層目錄，否則 React 產線退役（ADR-0017）會變成
      // 「刪應用層＝刪公開契約」。本區塊必須同時列 UI 層與 PARK 兩組 pattern：
      // ESLint 的 override 是「後者整組覆寫前者」，不是合併。
      // 已知射程外：`firestore.ts` 對 MeshChatService 的動態 import()——
      // no-restricted-imports 只看靜態 import 宣告，該處靠註解自律，收斂綁 ADR-0017。
      files: ['src/sdk/**/*.ts'],
      excludedFiles: ['**/*.spec.ts', '**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '**/features/**',
                  '**/pages/**',
                  '**/components/**',
                  '**/hooks/**',
                  '**/contexts/**',
                ],
                message: 'SDK 公開契約不得相依應用層目錄（Spec 013）。純邏輯請放 src/core/。',
              },
              {
                group: [
                  // 別名路徑（@/core/... 與 src/core/... 深層相對）
                  '**/core/community/**',
                  '**/core/game/**',
                  '**/core/transport/**',
                  '**/core/chain/**',
                  '**/core/ledger/**',
                  '**/core/protocol/**',
                  '**/core/features/**',
                  '**/core/relay/onion/**',
                ],
                message: '此模組已 PARK（休眠，ADR-0031），不得新接線。要解凍請改 ADR-0031 + 移除圍籬。',
              },
            ],
          },
        ],
      },
    },
  ],
};



