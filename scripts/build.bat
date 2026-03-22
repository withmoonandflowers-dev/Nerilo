@echo off
REM ============================================================
REM build.bat — 建置前端（tsc + vite build）
REM 用法：scripts\build.bat
REM       scripts\build.bat --check   (先跑 type-check + test)
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

set WITH_CHECK=false
for %%A in (%*) do (
  if "%%A"=="--check" set WITH_CHECK=true
)

echo ==========================================
echo  Nerilo Build
echo  專案根目錄: %PROJECT_ROOT%
echo ==========================================

if "%WITH_CHECK%"=="true" (
  echo.
  echo [pre-build] 執行品質檢查...
  call "%SCRIPT_DIR%check.bat"
  if %ERRORLEVEL% neq 0 (
    echo [FAIL] 品質檢查未通過，中止 build
    popd & exit /b 1
  )
)

echo.
echo [build] 執行 npm run build...

call npm run build
if %ERRORLEVEL% neq 0 (
  echo.
  echo ==========================================
  echo  [FAIL] Build 失敗
  echo ==========================================
  popd & exit /b 1
)

echo.
echo ==========================================
echo  [OK] Build 成功
echo   輸出目錄: dist\
echo ==========================================
popd
exit /b 0
