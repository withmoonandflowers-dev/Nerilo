#!/usr/bin/env bash
# ============================================================
# build.sh — 建置前端（tsc + vite build）
# 用法：bash scripts/build.sh
#       bash scripts/build.sh --check   (先跑 type-check + test)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

WITH_CHECK=false
for arg in "$@"; do
  [[ "$arg" == "--check" ]] && WITH_CHECK=true
done

echo "=========================================="
echo " Nerilo — Build"
echo " 專案根目錄: $PROJECT_ROOT"
echo "=========================================="

if $WITH_CHECK; then
  echo ""
  echo "[pre-build] 執行品質檢查..."
  bash "$SCRIPT_DIR/check.sh"
fi

echo ""
echo "[build] 執行 npm run build..."
START_TIME=$SECONDS

if npm run build 2>&1; then
  ELAPSED=$((SECONDS - START_TIME))
  echo ""
  echo "=========================================="
  echo " ✓ Build 成功（耗時 ${ELAPSED}s）"
  echo "   輸出目錄: dist/"
  echo "=========================================="
  exit 0
else
  echo ""
  echo "=========================================="
  echo " ✗ Build 失敗"
  echo "=========================================="
  exit 1
fi
