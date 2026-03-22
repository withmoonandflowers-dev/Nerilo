#!/usr/bin/env bash
# ============================================================
# test-coverage.sh — 單元測試 + Coverage 報表
# 產出 coverage/html/ 可用瀏覽器開啟查看行覆蓋率。
# 用法：bash scripts/test-coverage.sh
#       bash scripts/test-coverage.sh --open   (完成後自動開啟報表)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

OPEN_REPORT=false
for arg in "$@"; do
  [[ "$arg" == "--open" ]] && OPEN_REPORT=true
done

echo "=========================================="
echo " Nerilo — Coverage 報表"
echo " 專案根目錄: $PROJECT_ROOT"
echo "=========================================="
echo ""

if npm run test:coverage 2>&1; then
  echo ""
  echo "=========================================="
  echo " ✓ Coverage 報表產生完成"
  echo "   HTML: coverage/html/index.html"
  echo "=========================================="

  if $OPEN_REPORT; then
    REPORT="$PROJECT_ROOT/coverage/html/index.html"
    if [[ -f "$REPORT" ]]; then
      echo " 開啟報表..."
      if command -v xdg-open &>/dev/null; then
        xdg-open "$REPORT"
      elif command -v open &>/dev/null; then
        open "$REPORT"
      else
        echo " （請手動開啟：$REPORT）"
      fi
    fi
  fi
  exit 0
else
  echo ""
  echo "=========================================="
  echo " ✗ 測試失敗，Coverage 報表未產生"
  echo "=========================================="
  exit 1
fi
