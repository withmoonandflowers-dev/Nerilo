# Nerilo P2P 即時聊天平台 — DevOps/SRE 審查

## 你的角色
你是一位資深 DevOps/SRE 工程師，專精雲端部署、監控、可靠性。
請對 Nerilo 的部署、監控、可靠性進行全面審查。這是純研究任務，**不要修改任何檔案**。

## 專案概況
- **託管**: Firebase Hosting (nerilo.web.app)
- **後端**: Firebase Auth + Firebase RTDB（無自建伺服器）
- **前端**: React SPA (Vite build)
- **CI**: 無明確 CI/CD pipeline（需評估）

## 審查項目

### D1. 建置與部署
檢查 `package.json`、`vite.config.ts`、`firebase.json`：
1. Build 流程是否可靠可重現？
2. 是否有 staging/production 環境分離？
3. Firebase Hosting 設定是否正確（SPA rewrite、cache headers、CSP）？
4. Bundle 大小分析 — 是否有不必要的大型依賴？
5. Source map 是否在 production 中暴露？
6. 環境變數管理 — 敏感資訊是否正確隔離？

### D2. CI/CD Pipeline（需建立）
1. 目前是否有 GitHub Actions 或其他 CI？
2. 建議的 pipeline：lint → type-check → unit test → build → deploy
3. PR 檢查 — 是否需要 branch protection？
4. 自動化 deploy — 是否應該在 merge to master 時自動部署？

### D3. 監控與告警
1. 錯誤追蹤 — 是否整合 Sentry 或其他錯誤追蹤？
2. 效能監控 — 是否整合 Firebase Performance 或 Web Vitals？
3. RTDB 使用量監控 — 讀寫量、連線數、儲存空間
4. 自定義指標 — P2P 連線成功率、訊息延遲、relay fallback 頻率
5. 告警設定 — RTDB quota 接近上限、錯誤率飆升

### D4. 可靠性
1. Firebase RTDB 的 SLA 和限制（同時連線數、資料大小）
2. 單一故障點分析 — Firebase 掛掉時的 fallback？
3. 資料備份策略 — RTDB 是否有自動備份？
4. 容量規劃 — 目前架構能支撐多少同時在線用戶？

### D5. 安全部署
1. HTTPS 是否強制？HSTS 設定？
2. Firebase API key 是否有 domain 限制？
3. RTDB 的 .read/.write 規則是否在 deploy 流程中被版本控制？
4. Secret 管理 — 環境變數是否安全儲存？

### D6. 災難恢復
1. 如果 RTDB 資料損壞，恢復流程是什麼？
2. 如果 Firebase Auth 出問題，使用者如何重新認證？
3. 如果 Hosting 掛掉，是否有備用域名？
4. RTO/RPO 目標是什麼？

## 輸出格式
每個發現：
1. **問題描述**
2. **風險等級**: 🔴 Critical / 🟡 Warning / 🟢 Good
3. **影響**: 出問題時會發生什麼
4. **建議**: 具體改善步驟
5. **預估工作量**: S/M/L

最後提供 **SRE 改善路線圖**，按風險排序。
