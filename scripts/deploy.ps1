# 上板部署腳本（Hosting）
# 使用方式：
#   .\scripts\deploy.ps1           # 僅 build + firebase deploy --only hosting
#   .\scripts\deploy.ps1 -Check    # 先跑 type-check、lint、test:run 再 build + deploy
#   .\scripts\deploy.ps1 -Full     # build + firebase deploy（hosting + firestore + functions）

param(
    [switch]$Check,  # 上板前執行 type-check、lint、單元測試
    [switch]$Full    # 部署全部（hosting + firestore + functions），預設僅 hosting
)

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
Write-Host "[deploy] 專案根目錄: $ProjectRoot" -ForegroundColor Cyan

if ($Check) {
    Write-Host "[deploy] 執行上板前檢查（type-check、lint、單元測試）..." -ForegroundColor Yellow
    & npm run type-check
    if ($LASTEXITCODE -ne 0) { Write-Host "[deploy] type-check 失敗" -ForegroundColor Red; exit $LASTEXITCODE }
    & npm run lint
    if ($LASTEXITCODE -ne 0) { Write-Host "[deploy] lint 失敗" -ForegroundColor Red; exit $LASTEXITCODE }
    & npm run test:run
    if ($LASTEXITCODE -ne 0) { Write-Host "[deploy] 單元測試失敗" -ForegroundColor Red; exit $LASTEXITCODE }
    Write-Host "[deploy] 檢查通過" -ForegroundColor Green
}

Write-Host "[deploy] 建置前端 (npm run build)..." -ForegroundColor Yellow
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[deploy] build 失敗" -ForegroundColor Red
    exit $LASTEXITCODE
}

if ($Full) {
    Write-Host "[deploy] 部署全部 (firebase deploy)..." -ForegroundColor Yellow
    & firebase deploy
} else {
    Write-Host "[deploy] 部署 Hosting (firebase deploy --only hosting)..." -ForegroundColor Yellow
    & firebase deploy --only hosting
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "[deploy] 部署失敗" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "[deploy] 上板完成" -ForegroundColor Green
exit 0
