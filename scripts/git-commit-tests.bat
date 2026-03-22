@echo off
REM ============================================================
REM git-commit-tests.bat — 提交本輪新增的 unit tests + coverage 設定
REM 涵蓋範圍：
REM   - tests/unit/decideArchitecture.spec.ts
REM   - tests/unit/RoomService.spec.ts
REM   - tests/unit/MeshChatService.spec.ts
REM   - tests/unit/useChatMessages.spec.ts
REM   - vite.config.ts（coverage 範圍擴展）
REM   - scripts/*.sh / scripts/*.bat（本輪新增腳本）
REM
REM 用法：scripts\git-commit-tests.bat
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

echo ==========================================
echo  Nerilo Commit: Tests ^& Scripts
echo ==========================================

echo.
echo [pre-commit] type-check...
call npm run type-check
if %ERRORLEVEL% neq 0 (
  echo [FAIL] type-check 失敗，中止提交
  popd & exit /b 1
)
echo [OK] type-check 通過

echo.
echo [git] staging tests + scripts...

git add ^
  tests/unit/decideArchitecture.spec.ts ^
  tests/unit/RoomService.spec.ts ^
  tests/unit/MeshChatService.spec.ts ^
  tests/unit/useChatMessages.spec.ts ^
  vite.config.ts ^
  scripts/check.sh ^
  scripts/check.bat ^
  scripts/test.sh ^
  scripts/test.bat ^
  scripts/test-coverage.sh ^
  scripts/test-coverage.bat ^
  scripts/build.sh ^
  scripts/build.bat ^
  scripts/git-commit-fixes.sh ^
  scripts/git-commit-fixes.bat ^
  scripts/git-commit-tests.sh ^
  scripts/git-commit-tests.bat

if %ERRORLEVEL% neq 0 (
  echo [FAIL] git add 失敗
  popd & exit /b 1
)

echo.
echo [git] 確認 staging 清單：
git diff --cached --name-only

echo.
echo [git] 提交...

git commit -m "test: 新增四個 unit test、擴大 coverage、加入 Cowork 腳本" ^
  -m "Unit tests:" ^
  -m "- decideArchitecture.spec.ts: Star/Mesh 拓撲選擇邏輯" ^
  -m "- RoomService.spec.ts: isRoomTimeout 邊界值" ^
  -m "- MeshChatService.spec.ts: messageId 唯一性、訂閱/取消訂閱" ^
  -m "- useChatMessages.spec.ts: 去重、批量、reset、clear" ^
  -m "" ^
  -m "Coverage: 新增 useP2PArchitecture、useChatMessages、MeshChatService、RoomService" ^
  -m "" ^
  -m "Cowork scripts (sh + bat): check / test / test-coverage / build / git-commit" ^
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
