# 上板部署腳本（Hosting）
# 使用方式：
#   .\scripts\deploy.ps1           # 驗證 production env + build + deploy Hosting
#   .\scripts\deploy.ps1 -Check    # 先跑 type-check、lint、test:run
#   .\scripts\deploy.ps1 -Full -ConfirmFunctionsAndBilling
#                                  # 明確確認後才部署 Hosting + Firestore + Functions

param(
    [switch]$Check,  # 上板前執行 type-check、lint、單元測試
    [switch]$Full,   # 部署全部（hosting + firestore + functions），預設僅 hosting
    [switch]$ConfirmFunctionsAndBilling
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

if ($Full -and -not $ConfirmFunctionsAndBilling) {
    Write-Host "[deploy] 已阻擋：-Full 包含首次 Functions 部署與 Blaze 成本決策。" -ForegroundColor Red
    Write-Host "[deploy] 完成 runtime、secrets、region 與預算審查後，另加 -ConfirmFunctionsAndBilling。" -ForegroundColor Yellow
    exit 1
}

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

if ($Full) {
    Write-Host "[deploy] 執行受保護的完整部署..." -ForegroundColor Yellow
    & npm run deploy:full -- --confirm-functions-and-billing
} else {
    Write-Host "[deploy] 驗證環境並部署 production Hosting..." -ForegroundColor Yellow
    & npm run deploy:production
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "[deploy] 部署失敗" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "[deploy] 上板完成" -ForegroundColor Green
exit 0
