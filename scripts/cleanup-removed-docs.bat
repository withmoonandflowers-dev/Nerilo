@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."
echo Cleaning obsolete docs and junk files...

if exist "dummy" (
  del /f /q "dummy"
  echo Deleted: dummy
)

set "DOCS=docs"
del /f /q "%DOCS%\修復總結.md" 2>nul && echo Deleted: 修復總結.md
del /f /q "%DOCS%\最終修復總結.md" 2>nul && echo Deleted: 最終修復總結.md
del /f /q "%DOCS%\最終交付總結.md" 2>nul && echo Deleted: 最終交付總結.md
del /f /q "%DOCS%\最終交付報告.md" 2>nul && echo Deleted: 最終交付報告.md
del /f /q "%DOCS%\最終交付完整報告.md" 2>nul && echo Deleted: 最終交付完整報告.md
del /f /q "%DOCS%\最終交付文檔.md" 2>nul && echo Deleted: 最終交付文檔.md
del /f /q "%DOCS%\最終完整總結.md" 2>nul && echo Deleted: 最終完整總結.md
del /f /q "%DOCS%\功能實作完成總結.md" 2>nul && echo Deleted: 功能實作完成總結.md
del /f /q "%DOCS%\實作完成報告.md" 2>nul && echo Deleted: 實作完成報告.md
del /f /q "%DOCS%\實作進度.md" 2>nul && echo Deleted: 實作進度.md
del /f /q "%DOCS%\實作交付總結.md" 2>nul && echo Deleted: 實作交付總結.md
del /f /q "%DOCS%\多人聊天實作計劃.md" 2>nul && echo Deleted: 多人聊天實作計劃.md
del /f /q "%DOCS%\多人聊天整合指南.md" 2>nul && echo Deleted: 多人聊天整合指南.md
del /f /q "%DOCS%\多人聊天架構設計.md" 2>nul && echo Deleted: 多人聊天架構設計.md
del /f /q "%DOCS%\安全性實作總結.md" 2>nul && echo Deleted: 安全性實作總結.md
del /f /q "%DOCS%\安全性與多人聊天實作總結.md" 2>nul && echo Deleted: 安全性與多人聊天實作總結.md
del /f /q "%DOCS%\完整交付總結.md" 2>nul && echo Deleted: 完整交付總結.md
del /f /q "%DOCS%\完整E2E測試與專案邏輯總結.md" 2>nul && echo Deleted: 完整E2E測試與專案邏輯總結.md
del /f /q "%DOCS%\專案實作邏輯總結與建議.md" 2>nul && echo Deleted: 專案實作邏輯總結與建議.md
del /f /q "%DOCS%\專案實作邏輯與E2E測試完整總結.md" 2>nul && echo Deleted: 專案實作邏輯與E2E測試完整總結.md
del /f /q "%DOCS%\專案實作邏輯與建議.md" 2>nul && echo Deleted: 專案實作邏輯與建議.md
del /f /q "%DOCS%\專案架構與實作邏輯完整說明.md" 2>nul && echo Deleted: 專案架構與實作邏輯完整說明.md
del /f /q "%DOCS%\工作流程建議與修正.md" 2>nul && echo Deleted: 工作流程建議與修正.md
del /f /q "%DOCS%\工作流程與修正建議.md" 2>nul && echo Deleted: 工作流程與修正建議.md
del /f /q "%DOCS%\重構完成總結.md" 2>nul && echo Deleted: 重構完成總結.md
del /f /q "%DOCS%\重構與模組化總結.md" 2>nul && echo Deleted: 重構與模組化總結.md
del /f /q "%DOCS%\共享資料流驗證總結.md" 2>nul && echo Deleted: 共享資料流驗證總結.md
del /f /q "%DOCS%\e2e測試問題修復說明.md" 2>nul && echo Deleted: e2e測試問題修復說明.md
del /f /q "%DOCS%\E2E測試完整性報告.md" 2>nul && echo Deleted: E2E測試完整性報告.md
del /f /q "%DOCS%\E2E測試完整清單.md" 2>nul && echo Deleted: E2E測試完整清單.md
del /f /q "%DOCS%\E2E測試執行指南.md" 2>nul && echo Deleted: E2E測試執行指南.md
del /f /q "%DOCS%\Mesh測試優化說明.md" 2>nul && echo Deleted: Mesh測試優化說明.md
del /f /q "%DOCS%\P2P小網狀實作最終總結.md" 2>nul && echo Deleted: P2P小網狀實作最終總結.md
del /f /q "%DOCS%\P2P小網狀實作問題診斷.md" 2>nul && echo Deleted: P2P小網狀實作問題診斷.md
del /f /q "%DOCS%\P2P小網狀實作完成報告.md" 2>nul && echo Deleted: P2P小網狀實作完成報告.md
del /f /q "%DOCS%\P2P小網狀實作計劃.md" 2>nul && echo Deleted: P2P小網狀實作計劃.md
del /f /q "%DOCS%\P2P小網狀技術細節.md" 2>nul && echo Deleted: P2P小網狀技術細節.md
del /f /q "%DOCS%\P2P小網狀架構設計.md" 2>nul && echo Deleted: P2P小網狀架構設計.md
del /f /q "%DOCS%\P2P連線診斷日誌說明.md" 2>nul && echo Deleted: P2P連線診斷日誌說明.md
del /f /q "%DOCS%\P2P連線問題修復完成報告.md" 2>nul && echo Deleted: P2P連線問題修復完成報告.md
del /f /q "%DOCS%\P2P連線能力分析.md" 2>nul && echo Deleted: P2P連線能力分析.md
del /f /q "%DOCS%\P2P測試驗證總結.md" 2>nul && echo Deleted: P2P測試驗證總結.md
del /f /q "%DOCS%\P2P測試問題分析與修復報告.md" 2>nul && echo Deleted: P2P測試問題分析與修復報告.md
del /f /q "%DOCS%\Firestore修改建議.md" 2>nul && echo Deleted: Firestore修改建議.md
del /f /q "%DOCS%\Firestore結構與規則分析.md" 2>nul && echo Deleted: Firestore結構與規則分析.md
del /f /q "%DOCS%\驗證與Push說明.md" 2>nul && echo Deleted: 驗證與Push說明.md
del /f /q "%DOCS%\部署手冊.md" 2>nul && echo Deleted: 部署手冊.md

echo.
echo Cleanup finished. Remaining docs: see docs\README.md
endlocal
pause
