@echo off
REM ============================================================
REM check.bat — 品質門檻（type-check + 單元測試）
REM Cowork 在修改程式碼後呼叫，確認無型別錯誤與測試通過。
REM 用法：scripts\check.bat
REM       scripts\check.bat --lint   (加入 lint 檢查)
REM ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

set INCLUDE_LINT=false
for %%A in (%*) do (
  if "%%A"=="--lint" set INCLUDE_LINT=true
)

echo ==========================================
echo  Nerilo 品質門檻
echo  專案根目錄: %PROJECT_ROOT%
echo ==========================================

REM ── 1. TypeScript 型別檢查 ──────────────────────────────
echo.
echo [1/3] TypeScript type-check...
call npm run type-check
if %ERRORLEVEL% neq 0 (
  echo [FAIL] type-check 失敗
  popd & exit /b 1
)
echo [OK] type-check 通過

REM ── 2. Lint（選用）──────────────────────────────────────
echo.
if "%INCLUDE_LINT%"=="true" (
  echo [2/3] ESLint...
  call npm run lint
  if %ERRORLEVEL% neq 0 (
    echo [FAIL] lint 失敗
    popd & exit /b 1
  )
  echo [OK] lint 通過
) else (
  echo [2/3] ESLint 略過（加 --lint 參數可啟用）
)

REM ── 3. 單元測試 ─────────────────────────────────────────
echo.
echo [3/3] 單元測試 (vitest run)...
call npm run test:run
if %ERRORLEVEL% neq 0 (
  echo [FAIL] 單元測試失敗
  popd & exit /b 1
)
echo [OK] 單元測試全部通過

echo.
echo ==========================================
echo  [OK] 品質門檻通過 — 可安全 push / PR
echo ==========================================
popd
exit /b 0
