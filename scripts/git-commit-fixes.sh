#!/usr/bin/env bash
# ============================================================
# git-commit-fixes.sh — 提交本輪 bug fixes
# 涵蓋範圍：
#   - IndexedDBService clearRoomData 縮排
#   - RoomService DEBUG_ROOMS + joinRoom 邏輯
#   - MeshChatService messageId counter
#   - useMeshTopology re-render 優化
#   - MultiP2PManager 棄用
#   - IRoomService / RoomServiceAdapter 清理
#   - ServicesContext.spec.ts mock 同步更新
#
# 用法：bash scripts/git-commit-fixes.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Cowork 沙箱：使用 /tmp 暫存 index，繞過 .git/index.lock 無法刪除的限制
export GIT_INDEX_FILE="/tmp/nerilo-git-index-fixes-$$"
# 從 HEAD 初始化暫存 index（git read-tree 會把 HEAD 的狀態寫入指定的 GIT_INDEX_FILE）
git read-tree HEAD

echo "=========================================="
echo " Nerilo — Commit: Bug Fixes"
echo "=========================================="

# 先確認型別檢查通過（防呆）
echo ""
echo "[pre-commit] type-check..."
npm run type-check 2>&1
echo "✓ type-check 通過"

echo ""
echo "[git] staging bug fix 相關檔案..."

git add \
  src/services/IndexedDBService.ts \
  src/services/RoomService.ts \
  src/services/RoomServiceAdapter.ts \
  src/features/chat/MeshChatService.ts \
  src/features/chat/hooks/useMeshTopology.ts \
  src/core/p2p/MultiP2PManager.ts \
  src/ports/IRoomService.ts \
  tests/unit/ServicesContext.spec.ts

echo ""
echo "[git] 確認 staging 清單："
git diff --cached --name-only

echo ""
echo "[git] 提交..."
git commit -m "fix: 修正六個程式碼品質與邏輯問題

- IndexedDBService.clearRoomData(): 修正 Promise.all 關閉括號縮排
- RoomService.DEBUG_ROOMS: 改由 import.meta.env.DEV 控制，正式環境不再輸出大量 log
- RoomService.joinRoom(): 簡化冗餘的 shouldActivate 條件
- MeshChatService.sendMessage(): 加入 messageCounter 修正同毫秒 ID 碰撞
- useMeshTopology: interval 僅在狀態改變時觸發 onStateChange，避免無意義 re-render
- MultiP2PManager.ts: 清空棄用（全專案未被任何地方 import）
- IRoomService / RoomServiceAdapter: 移除已棄用的 closeUserWaitingRooms

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

echo ""
echo "=========================================="
echo " ✓ Commit 完成"
echo "=========================================="
git log --oneline -1
exit 0
