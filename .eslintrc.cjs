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
                  '**/core/community/**',
                  '**/core/game/**',
                  '**/core/transport/**',
                  '**/core/chain/**',
                  '**/core/ledger/**',
                  '**/core/protocol/**',
                ],
                message: '此模組已 PARK（休眠，ADR-0031），不得新接線。要解凍請改 ADR-0031 + 移除圍籬。',
              },
            ],
          },
        ],
      },
    },
    {
      // 死重圍籬（產品/SDK 層）：features/pages/sdk 亦不得 import PARK 模組（ADR-0031）。
      files: ['src/features/**/*.ts', 'src/features/**/*.tsx', 'src/pages/**/*.tsx', 'src/sdk/**/*.ts'],
      excludedFiles: ['**/*.spec.ts', '**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '**/core/community/**',
                  '**/core/game/**',
                  '**/core/transport/**',
                  '**/core/chain/**',
                  '**/core/ledger/**',
                  '**/core/protocol/**',
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



