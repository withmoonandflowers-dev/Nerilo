@echo off
REM ============================================================
REM setup-cowork.bat — Cowork 沙箱一次性環境設置檢查（Windows 版）
REM
REM 作用：
REM   1. 偵測 node_modules 中是否缺少跨平台原生模組
REM   2. 指示使用者如何在本機補齊（一次即永久）
REM   3. 說明後續 Cowork 可呼叫的所有腳本
REM
REM 用法：scripts\setup-cowork.bat
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

set ISSUES=0

echo ==========================================
echo  Nerilo — Cowork 環境設置檢查
echo ==========================================
echo.

REM ── 1. node_modules 是否存在 ─────────────────────────────
echo [1/3] 檢查 node_modules...
if not exist "node_modules" (
  echo   [X] node_modules 不存在
  echo       請執行：npm install
  set /a ISSUES+=1
) else (
  echo   [OK] node_modules 存在
)

REM ── 2. 跨平台 rollup 原生模組 ────────────────────────────
echo.
echo [2/3] 檢查 rollup 跨平台原生模組...
set ROLLUP_LINUX=0
if exist "node_modules\@rollup\rollup-linux-x64-gnu" set ROLLUP_LINUX=1
if exist "node_modules\@rollup\rollup-linux-x64-musl" set ROLLUP_LINUX=1

if "%ROLLUP_LINUX%"=="0" (
  echo   [X] @rollup/rollup-linux-x64-gnu 缺少
  echo       Cowork 沙箱（Linux）執行 vitest 時會失敗
  set /a ISSUES+=1
) else (
  echo   [OK] rollup Linux 原生模組存在
)

REM ── 3. 跨平台 esbuild 原生模組 ───────────────────────────
echo.
echo [3/3] 檢查 esbuild 跨平台原生模組...
if not exist "node_modules\@esbuild\linux-x64" (
  echo   [X] @esbuild/linux-x64 缺少
  echo       Cowork 沙箱執行 vite build 時會失敗
  set /a ISSUES+=1
) else (
  echo   [OK] esbuild Linux 原生模組存在
)

REM ── 結果 ─────────────────────────────────────────────────
echo.
echo ==========================================

if %ISSUES% equ 0 (
  echo  [OK] 環境就緒 — Cowork 可直接呼叫所有腳本
  echo.
  echo  可用指令 ^(由 Cowork 呼叫^)：
  echo    bash scripts/check.sh
  echo    bash scripts/test.sh
  echo    bash scripts/test-coverage.sh
  echo    bash scripts/build.sh
  echo    bash scripts/git-commit-fixes.sh
  echo    bash scripts/git-commit-tests.sh
  echo ==========================================
  popd
  exit /b 0
) else (
  echo  [FAIL] 發現 %ISSUES% 個問題，請先修正
  echo.
  echo  +--------------------------------------------------+
  echo  ^|  必要步驟（在此 Windows 終端機執行）            ^|
  echo  ^|                                                  ^|
  echo  ^|  npm install                                     ^|
  echo  ^|                                                  ^|
  echo  ^|  package.json 已含 optionalDependencies，        ^|
  echo  ^|  install 後自動取得所有平台（Linux/Mac/Win）     ^|
  echo  ^|  的原生二進位，Cowork 即可正常執行測試與建置。  ^|
  echo  ^|                                                  ^|
  echo  ^|  完成後重新執行：                                ^|
  echo  ^|    scripts\setup-cowork.bat                      ^|
  echo  +--------------------------------------------------+
  echo ==========================================
  popd
  exit /b 1
)
