#!/usr/bin/env bash
# =============================================================================
# test-integration.sh — 啟動 Firebase Emulator 並執行整合測試
#
# 用法：
#   bash scripts/test-integration.sh
#
# 前提條件：
#   - Node.js >= 18
#   - Java >= 11（已確認 OpenJDK 11 可用）
#   - firebase-tools：npm install -g firebase-tools
#
# 業界標準：
#   整合測試（Integration Tests）直接對 Firebase Emulator 發送真實 SDK 呼叫，
#   驗證安全規則、資料模型、讀寫行為——不 mock、不連線正式環境。
# =============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── 1. 前置條件檢查 ──────────────────────────────────────────────────────────

echo "=== Firebase Emulator 整合測試 ==="
echo ""

if ! command -v firebase &>/dev/null; then
  echo "❌  firebase-tools 未安裝"
  echo ""
  echo "    安裝方式："
  echo "      npm install -g firebase-tools"
  echo ""
  echo "    安裝後登入（只需一次）："
  echo "      firebase login"
  echo ""
  exit 1
fi

if ! command -v java &>/dev/null; then
  echo "❌  Java 未安裝（Firebase Emulator 需要 Java 11+）"
  exit 1
fi

echo "✓ firebase-tools: $(firebase --version)"
echo "✓ java: $(java -version 2>&1 | head -1)"
echo ""

# ── 2. 確認 Emulator 設定存在 ───────────────────────────────────────────────

if ! grep -q '"emulators"' firebase.json; then
  echo "❌  firebase.json 中未找到 emulators 設定"
  exit 1
fi

# ── 3. 以 emulators:exec 啟動 Emulator 並跑測試 ─────────────────────────────

echo "▶  啟動 Auth + Firestore Emulator 並執行整合測試..."
echo ""

firebase emulators:exec \
  --only auth,firestore \
  --project nerilo \
  "npx vitest run --config vitest.integration.config.ts"

EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "✅  整合測試全部通過"
else
  echo "❌  整合測試失敗（exit code: $EXIT_CODE）"
fi

exit $EXIT_CODE
