@echo off
REM ============================================================
REM test.bat — 執行全部單元測試
REM 用法：scripts\test.bat
REM       scripts\test.bat --watch   (監聽模式，開發中用)
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

set WATCH_MODE=false
for %%A in (%*) do (
  if "%%A"=="--watch" set WATCH_MODE=true
)

echo ==========================================
echo  Nerilo 單元測試
echo  專案根目錄: %PROJECT_ROOT%
echo ==========================================

if "%WATCH_MODE%"=="true" (
  echo 啟動監聽模式 ^(Ctrl+C 離開^)...
  call npm run test
) else (
  echo 執行所有單元測試...
  echo.
  call npm run test:run
  if %ERRORLEVEL% neq 0 (
    echo.
    echo ==========================================
    echo  [FAIL] 測試失敗，請修正後重新執行
    echo ==========================================
    popd & exit /b 1
  )
  echo.
  echo ==========================================
  echo  [OK] 所有單元測試通過
  echo ==========================================
)

popd
exit /b 0
