#!/usr/bin/env bash
# ============================================================
# setup-cowork.sh — Cowork 沙箱一次性環境設置檢查
#
# 作用：
#   1. 偵測 node_modules 中是否缺少 Linux 原生模組
#   2. 指示使用者如何在本機補齊（一次即永久）
#   3. 確認 git 可正常運作（繞過 index.lock 限制）
#
# 用法：bash scripts/setup-cowork.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=========================================="
echo " Nerilo — Cowork 環境設置檢查"
echo "=========================================="
echo ""

ISSUES=0

# ── 1. node_modules 是否存在 ───────────────────────────────
echo "[1/4] 檢查 node_modules..."
if [ ! -d "node_modules" ]; then
  echo "  ✗ node_modules 不存在"
  echo "    → 請在 Windows 機器上執行：npm install"
  ISSUES=$((ISSUES + 1))
else
  echo "  ✓ node_modules 存在"
fi

# ── 2. Linux 原生模組（rollup）──────────────────────────────
echo ""
echo "[2/4] 檢查 rollup Linux 原生模組..."
ROLLUP_OK=false
if [ -d "node_modules/@rollup/rollup-linux-x64-gnu" ]; then
  echo "  ✓ @rollup/rollup-linux-x64-gnu 存在"
  ROLLUP_OK=true
elif [ -d "node_modules/@rollup/rollup-linux-x64-musl" ]; then
  echo "  ✓ @rollup/rollup-linux-x64-musl 存在"
  ROLLUP_OK=true
else
  echo "  ✗ @rollup/rollup-linux-x64-gnu 缺少"
  ISSUES=$((ISSUES + 1))
fi

# ── 3. Linux 原生模組（esbuild）─────────────────────────────
echo ""
echo "[3/4] 檢查 esbuild Linux 原生模組..."
if [ -d "node_modules/@esbuild/linux-x64" ]; then
  echo "  ✓ @esbuild/linux-x64 存在"
else
  echo "  ✗ @esbuild/linux-x64 缺少"
  ISSUES=$((ISSUES + 1))
fi

# ── 4. Git 可用性（測試 GIT_INDEX_FILE 繞過機制）───────────
echo ""
echo "[4/4] 檢查 git 操作環境..."
TEST_INDEX="/tmp/nerilo-setup-test-$$"
if GIT_INDEX_FILE="$TEST_INDEX" git read-tree HEAD > /dev/null 2>&1; then
  echo "  ✓ git 可正常運作（GIT_INDEX_FILE 繞過機制有效）"
  rm -f "$TEST_INDEX" 2>/dev/null || true
else
  echo "  ✗ git read-tree 失敗（可能未初始化 git repo）"
  ISSUES=$((ISSUES + 1))
fi

# ── 結果 ───────────────────────────────────────────────────
echo ""
echo "=========================================="

if [ "$ISSUES" -eq 0 ]; then
  echo " ✓ 環境就緒 — Cowork 可直接呼叫所有腳本"
  echo ""
  echo " 可用指令："
  echo "   bash scripts/check.sh          # 型別檢查 + 單元測試"
  echo "   bash scripts/test.sh           # 單元測試"
  echo "   bash scripts/test-coverage.sh  # 測試覆蓋率報表"
  echo "   bash scripts/build.sh          # 前端建置"
  echo "   bash scripts/git-commit-fixes.sh  # 提交 bug fixes"
  echo "   bash scripts/git-commit-tests.sh  # 提交新測試"
  echo "=========================================="
  exit 0
else
  echo " ✗ 發現 $ISSUES 個問題，請先修正"
  echo ""
  echo " ┌──────────────────────────────────────────────────┐"
  echo " │  必要步驟（在您的 Windows/Mac 機器終端機執行）   │"
  echo " │                                                  │"
  echo " │  cd $(pwd | sed 's|.*/||')                         │"
  echo " │  npm install                                     │"
  echo " │                                                  │"
  echo " │  完成後重新執行：                                │"
  echo " │  bash scripts/setup-cowork.sh                   │"
  echo " └──────────────────────────────────────────────────┘"
  echo "=========================================="
  exit 1
fi
