# 單元測試 + 全部 E2E 測試（一鍵）
# 使用方式：在專案根目錄執行 .\scripts\run-all-tests.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    $ProjectRoot = $PSScriptRoot
    while ($ProjectRoot) {
        if (Test-Path (Join-Path $ProjectRoot "package.json")) { break }
        $ProjectRoot = Split-Path -Parent $ProjectRoot
    }
}
if (-not $ProjectRoot -or -not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    Write-Error "找不到專案根目錄（含 package.json）"
    exit 1
}

Set-Location $ProjectRoot
Write-Host "[run-all-tests] 專案根目錄: $ProjectRoot"

Write-Host "[run-all-tests] 1/2 執行單元測試..."
& npm run test:run
$unitExit = $LASTEXITCODE
if ($unitExit -ne 0) {
    Write-Host "[run-all-tests] 單元測試失敗，結束。" -ForegroundColor Red
    exit $unitExit
}

Write-Host "[run-all-tests] 2/2 執行全部 E2E 測試..."
& npm run test:e2e -- --timeout=90000
$e2eExit = $LASTEXITCODE
if ($e2eExit -ne 0) {
    Write-Host "[run-all-tests] E2E 測試失敗。" -ForegroundColor Red
    exit $e2eExit
}

Write-Host "[run-all-tests] 全部通過。" -ForegroundColor Green
exit 0
