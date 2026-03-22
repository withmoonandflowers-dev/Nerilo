#!/usr/bin/env bash
# ============================================================
# test.sh — 執行全部單元測試
# 用法：bash scripts/test.sh
#       bash scripts/test.sh --watch   (監聽模式，開發中用)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

WATCH_MODE=false
for arg in "$@"; do
  [[ "$arg" == "--watch" ]] && WATCH_MODE=true
done

echo "=========================================="
echo " Nerilo — 單元測試"
echo " 專案根目錄: $PROJECT_ROOT"
echo "=========================================="

if $WATCH_MODE; then
  echo "啟動監聽模式 (Ctrl+C 離開)..."
  exec npm run test
else
  echo "執行所有單元測試..."
  echo ""
  if npm run test:run 2>&1; then
    echo ""
    echo "=========================================="
    echo " ✓ 所有單元測試通過"
    echo "=========================================="
    exit 0
  else
    echo ""
    echo "=========================================="
    echo " ✗ 測試失敗，請修正後重新執行"
    echo "=========================================="
    exit 1
  fi
fi
