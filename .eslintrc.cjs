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
      // ── 前後端合約邊界（機器強制）─────────────────────────────────────
      // 後端（core/services）不得依賴前端框架或 UI 層。依賴方向必須單向：
      // 前端 → 後端，後端永不 → 前端。這保證 UI 可獨立換皮/重寫（React→Vue、
      // 改風格）而不觸碰後端。詳見 docs/architecture/frontend-backend-contract.md。
      files: ['src/core/**/*.ts', 'src/services/**/*.ts'],
      excludedFiles: ['**/*.spec.ts', '**/*.test.ts'],
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
            ],
          },
        ],
      },
    },
  ],
};



