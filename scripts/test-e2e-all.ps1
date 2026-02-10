# 全部 E2E 測試
# 使用方式：在專案根目錄執行 .\scripts\test-e2e-all.ps1

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
Write-Host "[test-e2e-all] 專案根目錄: $ProjectRoot"
Write-Host "[test-e2e-all] 執行全部 E2E 測試（timeout 90s）..."

& npm run test:e2e -- --timeout=90000
exit $LASTEXITCODE
