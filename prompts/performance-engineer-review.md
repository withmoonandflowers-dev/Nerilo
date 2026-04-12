# Nerilo P2P 即時聊天平台 — 效能工程師審查

## 你的角色
你是一位資深效能工程師，專精前端效能、WebRTC 效能調優、即時系統效能。
請對 Nerilo 的效能進行全面審查。這是純研究任務，**不要修改任何檔案**。

## 專案概況
- **前端**: React 18 + Vite 5 + Tailwind
- **通訊**: WebRTC DataChannel + Firebase RTDB fallback
- **目標**: 支援 2-20+ 人即時聊天，訊息延遲 < 200ms

## 審查項目

### P1. Bundle 效能
檢查 `package.json`、`vite.config.ts`：
1. Bundle 總大小和各 chunk 大小分析
2. Tree-shaking 是否有效？Firebase SDK 是否正確 tree-shaken？
3. Code splitting — 是否按路由/功能拆分？
4. 未使用的依賴（dead dependencies）
5. 重複依賴（同一個 library 的多個版本）

### P2. 執行時效能
1. React re-render 分析 — 哪些元件重渲染過多？
2. 記憶體使用 — 長時間使用是否有 memory leak？（特別是 P2P 連線和 RTDB 訂閱）
3. WebRTC connection 的 CPU/記憶體開銷 — N 人房間的 scalability
4. Gossip protocol 的 message amplification — fan-out * TTL 的最壞情況
5. 加密操作的效能 — SubtleCrypto 是否在主執行緒？是否應該用 Web Worker？

### P3. 網路效能
1. Firebase RTDB 的讀寫量 — signaling 階段的 burst 量
2. ICE candidate 是否有 trickle batching？
3. WebRTC DataChannel 的 throughput 和 backpressure
4. RTDB listener 數量 — 是否有過多的即時訂閱？
5. Relay 路徑的延遲分析

### P4. 載入效能
1. First Contentful Paint (FCP) — 目標 < 1.5s
2. Largest Contentful Paint (LCP) — 目標 < 2.5s
3. Time to Interactive (TTI) — Firebase Auth 初始化的影響
4. Cumulative Layout Shift (CLS) — 是否有版面跳動？
5. 字型載入策略 — 是否使用 font-display: swap？

### P5. 資料結構效能
1. 頻繁操作的資料結構是否最佳化？（Map vs Object, Set vs Array）
2. 排序/搜尋演算法是否適當？
3. 快取策略 — 是否善用 LRU cache？
4. 序列化/反序列化開銷（JSON.parse/stringify 頻率）

### P6. 壓力測試場景
描述以下場景的預期效能：
1. 10 人同時加入房間的 signaling burst
2. 20 人 mesh 網路的 gossip 廣播風暴
3. 1000+ 則歷史訊息的渲染效能
4. 頻繁斷線重連（手機網路切換）
5. 長時間掛機（1 小時+）的 memory profile

## 輸出格式
每個發現：
1. **瓶頸描述**
2. **影響程度**: 🔴 Blocking / 🟡 Degraded / 🟢 Acceptable
3. **量化數據**（如果可以估算）
4. **最佳化建議**
5. **預期改善幅度**

最後提供 **效能最佳化路線圖**，按 ROI 排序（改善幅度/工作量）。
