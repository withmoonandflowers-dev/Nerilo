@echo off
REM ============================================================
REM git-commit-fixes.bat — 提交本輪 bug fixes
REM 涵蓋範圍：
REM   - IndexedDBService clearRoomData 縮排
REM   - RoomService DEBUG_ROOMS + joinRoom 邏輯
REM   - MeshChatService messageId counter
REM   - useMeshTopology re-render 優化
REM   - MultiP2PManager 棄用
REM   - IRoomService / RoomServiceAdapter 清理
REM   - ServicesContext.spec.ts mock 同步更新
REM
REM 用法：scripts\git-commit-fixes.bat
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

echo ==========================================
echo  Nerilo Commit: Bug Fixes
echo ==========================================

REM ── 防呆：先型別檢查 ──────────────────────────────────
echo.
echo [pre-commit] type-check...
call npm run type-check
if %ERRORLEVEL% neq 0 (
  echo [FAIL] type-check 失敗，中止提交
  popd & exit /b 1
)
echo [OK] type-check 通過

REM ── Staging ───────────────────────────────────────────
echo.
echo [git] staging bug fix 相關檔案...

git add ^
  src/services/IndexedDBService.ts ^
  src/services/RoomService.ts ^
  src/services/RoomServiceAdapter.ts ^
  src/features/chat/MeshChatService.ts ^
  src/features/chat/hooks/useMeshTopology.ts ^
  src/core/p2p/MultiP2PManager.ts ^
  src/ports/IRoomService.ts ^
  tests/unit/ServicesContext.spec.ts

if %ERRORLEVEL% neq 0 (
  echo [FAIL] git add 失敗
  popd & exit /b 1
)

echo.
echo [git] 確認 staging 清單：
git diff --cached --name-only

REM ── Commit ────────────────────────────────────────────
echo.
echo [git] 提交...

git commit -m "fix: 修正六個程式碼品質與邏輯問題" ^
  -m "- IndexedDBService.clearRoomData(): 修正 Promise.all 關閉括號縮排" ^
  -m "- RoomService.DEBUG_ROOMS: 改由 import.meta.env.DEV 控制，正式環境不再輸出大量 log" ^
  -m "- RoomService.joinRoom(): 簡化冗餘的 shouldActivate 條件" ^
  -m "- MeshChatService.sendMessage(): 加入 messageCounter 修正同毫秒 ID 碰撞" ^
  -m "- useMeshTopology: interval 僅在狀態改變時觸發 onStateChange，避免無意義 re-render" ^
  -m "- MultiP2PManager.ts: 清空棄用（全專案未被任何地方 import）" ^
  -m "- IRoomService / RoomServiceAdapter: 移除已棄用的 closeUserWaitingRooms" ^
  -m "" ^
  -m "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

if %ERRORLEVEL% neq 0 (
  echo [FAIL] git commit 失敗
  popd & exit /b 1
)

echo.
echo ==========================================
echo  [OK] Commit 完成
echo ==========================================
git log --oneline -1
popd
exit /b 0
