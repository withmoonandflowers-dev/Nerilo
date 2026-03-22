#!/usr/bin/env bash
# ============================================================
# check.sh — 品質門檻（type-check + 單元測試）
# Cowork 在修改程式碼後呼叫，確認無型別錯誤與測試通過。
# 用法：bash scripts/check.sh
#       bash scripts/check.sh --lint   (加入 lint 檢查)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

INCLUDE_LINT=false
for arg in "$@"; do
  [[ "$arg" == "--lint" ]] && INCLUDE_LINT=true
done

echo "=========================================="
echo " Nerilo — 品質門檻"
echo " 專案根目錄: $PROJECT_ROOT"
echo "=========================================="

# ── 0. 環境前置檢查（rollup Linux 模組，型別檢查與測試所需）────
echo ""
echo "[0/3] 環境檢查..."

# rollup 是 vitest 所需（stub 或真實二進位均可接受）
if [ ! -d "node_modules/@rollup/rollup-linux-x64-gnu" ] && \
   [ ! -d "node_modules/@rollup/rollup-linux-x64-musl" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  ⚠  缺少 rollup Linux 模組，無法執行單元測試        ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  解決方式（在您的 Windows/Mac 機器上執行一次）：     ║"
  echo "║                                                      ║"
  echo "║    npm install                                       ║"
  echo "║                                                      ║"
  echo "║  完成後 Cowork 即可直接執行此腳本。                  ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

# esbuild 是 vitest 啟動所需（vitest 內建版本或頂層版本均可）
ESBUILD_LINUX_OK=false
if [ -d "node_modules/@esbuild/linux-x64" ] || \
   [ -d "node_modules/vitest/node_modules/@esbuild/linux-x64" ]; then
  ESBUILD_LINUX_OK=true
fi

if ! $ESBUILD_LINUX_OK; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  ⚠  缺少 esbuild Linux 模組，vitest 無法啟動        ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  請執行 scripts/setup-cowork.sh 進行診斷             ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

echo "✓ 環境就緒"

# ── 1. TypeScript 型別檢查 ─────────────────────────────────
echo ""
echo "[1/3] TypeScript type-check..."

if npm run type-check 2>&1; then
  echo "✓ type-check 通過"
else
  echo "✗ type-check 失敗"
  exit 1
fi

# ── 2. Lint（選用） ────────────────────────────────────────
if $INCLUDE_LINT; then
  echo ""
  echo "[2/3] ESLint..."
  if npm run lint 2>&1; then
    echo "✓ lint 通過"
  else
    echo "✗ lint 失敗"
    exit 1
  fi
else
  echo ""
  echo "[2/3] ESLint（略過，加 --lint 參數可啟用）"
fi

# ── 3. 單元測試 ────────────────────────────────────────────
echo ""
echo "[3/3] 單元測試 (vitest run)..."
if npm run test:run 2>&1; then
  echo "✓ 單元測試全部通過"
else
  echo "✗ 單元測試失敗"
  exit 1
fi

echo ""
echo "=========================================="
echo " ✓ 品質門檻通過 — 可安全 push / PR"
echo "=========================================="
exit 0
