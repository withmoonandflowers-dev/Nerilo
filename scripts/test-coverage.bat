@echo off
REM ============================================================
REM test-coverage.bat — 單元測試 + Coverage 報表
REM 產出 coverage\html\ 可用瀏覽器開啟查看行覆蓋率。
REM 用法：scripts\test-coverage.bat
REM       scripts\test-coverage.bat --open   (完成後自動開啟報表)
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

set OPEN_REPORT=false
for %%A in (%*) do (
  if "%%A"=="--open" set OPEN_REPORT=true
)

echo ==========================================
echo  Nerilo Coverage 報表
echo  專案根目錄: %PROJECT_ROOT%
echo ==========================================
echo.

call npm run test:coverage
if %ERRORLEVEL% neq 0 (
  echo.
  echo ==========================================
  echo  [FAIL] 測試失敗，Coverage 報表未產生
  echo ==========================================
  popd & exit /b 1
)

echo.
echo ==========================================
echo  [OK] Coverage 報表產生完成
echo   HTML: coverage\html\index.html
echo ==========================================

if "%OPEN_REPORT%"=="true" (
  set "REPORT=%PROJECT_ROOT%\coverage\html\index.html"
  if exist "!REPORT!" (
    echo  開啟報表...
    start "" "!REPORT!"
  )
)

popd
exit /b 0
