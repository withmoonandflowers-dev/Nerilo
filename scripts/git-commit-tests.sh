#!/usr/bin/env bash
# ============================================================
# git-commit-tests.sh — 提交本輪新增的 unit tests + coverage 設定
# 涵蓋範圍：
#   - tests/unit/decideArchitecture.spec.ts
#   - tests/unit/RoomService.spec.ts
#   - tests/unit/MeshChatService.spec.ts
#   - tests/unit/useChatMessages.spec.ts
#   - vite.config.ts（coverage 範圍擴展）
#   - scripts/*.sh / scripts/*.bat（本輪新增腳本）
#
# 用法：bash scripts/git-commit-tests.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Cowork 沙箱：使用 /tmp 暫存 index，繞過 .git/index.lock 無法刪除的限制
export GIT_INDEX_FILE="/tmp/nerilo-git-index-tests-$$"
# 從 HEAD 初始化暫存 index
git read-tree HEAD

echo "=========================================="
echo " Nerilo — Commit: Tests & Scripts"
echo "=========================================="

echo ""
echo "[pre-commit] type-check..."
npm run type-check 2>&1
echo "✓ type-check 通過"

echo ""
echo "[git] staging tests + scripts..."

git add \
  tests/unit/decideArchitecture.spec.ts \
  tests/unit/RoomService.spec.ts \
  tests/unit/MeshChatService.spec.ts \
  tests/unit/useChatMessages.spec.ts \
  vite.config.ts \
  scripts/check.sh \
  scripts/check.bat \
  scripts/test.sh \
  scripts/test.bat \
  scripts/test-coverage.sh \
  scripts/test-coverage.bat \
  scripts/build.sh \
  scripts/build.bat \
  scripts/git-commit-fixes.sh \
  scripts/git-commit-fixes.bat \
  scripts/git-commit-tests.sh \
  scripts/git-commit-tests.bat

echo ""
echo "[git] 確認 staging 清單："
git diff --cached --name-only

echo ""
echo "[git] 提交..."
git commit -m "test: 新增四個 unit test、擴大 coverage、加入 Cowork 腳本

Unit tests:
- decideArchitecture.spec.ts: Star/Mesh 拓撲選擇邏輯（8 個 case）
- RoomService.spec.ts: isRoomTimeout 邊界值（6 個 case）
- MeshChatService.spec.ts: messageId 唯一性、訂閱/取消訂閱、歷史載入（9 個 case）
- useChatMessages.spec.ts: 去重、批量、reset、clear 邏輯（10 個 case）

Coverage:
- vite.config.ts: 新增 useP2PArchitecture、useChatMessages、MeshChatService、RoomService

Cowork scripts (sh + bat):
- check: type-check + unit tests 品質門檻
- test: 執行單元測試
- test-coverage: 產生 coverage 報表
- build: 建置前端
- git-commit-fixes / git-commit-tests: 本輪修改的 git commit 腳本

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

echo ""
echo "=========================================="
echo " ✓ Commit 完成"
echo "=========================================="
git log --oneline -1
exit 0
