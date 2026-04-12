# Nerilo P2P 即時聊天平台 — 架構審查

## 你的角色
你是一位資深分散式系統架構師，專精 WebRTC、P2P 網路、即時通訊架構。
請對 Nerilo 專案進行全面的架構審查。

## 專案概況
- **Repo**: https://github.com/withmoonandflowers-dev/Nerilo
- **Branch**: feature/multi-room-improvements
- **技術棧**: React 18 + TypeScript + Vite + Firebase Auth + Firebase RTDB + WebRTC
- **定位**: 瀏覽器端 P2P 即時聊天，支援 2-20+ 人拓撲自適應

## 架構審查項目

### A. 拓撲策略評估
檢查 `src/core/` 下的拓撲設計：
1. Star (2人) → Full Mesh (3-5人) → Partial Mesh (6-20) → Super-Node (>20)
2. 拓撲切換的觸發條件是否合理？切換過程中的訊息遺失風險？
3. `AdaptiveTopologyManager` 的 hysteresis 機制是否防止了抖動切換？
4. Mesh gossip protocol 的 fan-out 參數是否適合目標規模？

### B. 信令架構
檢查 `src/core/p2p/P2PConnectionManager.ts`：
1. 目前用 Firebase RTDB 做 signaling — 延遲、可靠性、成本分析
2. Signal 隔離策略（channelLabel + sessionStartedAt 過濾）是否足夠？
3. ICE candidate buffering 策略是否處理了所有 race condition？
4. Auto-reconnect 的 ICE Restart → Full Renegotiation 兩階段策略是否業界最佳？

### C. E2EE 加密架構
檢查 `src/core/crypto/`：
1. SenderKey (<50人) vs TreeKEM (≥50人) 的切換邊界是否合理？
2. Key rotation（100 msg / 1 hour）的頻率是否平衡安全與效能？
3. Forward secrecy 的 epoch key retention 是否有記憶體洩漏風險？
4. ECDH P-256 key exchange 透過 P2PChannelBus 廣播是否有 MITM 風險？

### D. Relay 基礎設施
檢查 `src/core/relay/`：
1. Sphinx-Lite onion routing 的 2-3 hop 設計是否提供足夠匿名性？
2. Kademlia DHT 的 S/Kademlia diversified routing 實作是否完整？
3. Cover traffic（Poisson-distributed）在電池裝置上的影響？
4. Multi-path selector 的 greedy construction 是否會退化為單一路徑？

### E. 資料一致性
1. HLC (Hybrid Logical Clock) 在跨時區/NTP 偏移下的行為？
2. Append-only log sync & merge（ChainSyncService）的衝突解決策略？
3. Shared ledger engine 的一致性保證級別（eventual? causal?）？

### F. Firebase RTDB 架構
檢查 `src/config/rtdb-paths.ts` 和 `database.rules.json`：
1. 資料結構是否適合 RTDB 的 flat JSON 模型？
2. Security rules 是否有越權風險？
3. 在 /rooms 上的 .read: "auth != null" 是否允許任何已驗證用戶讀取所有房間？
4. indexOn 是否覆蓋所有 orderByChild 查詢？

## 輸出格式
對每個審查項目：
1. **現狀分析**（1-2 句）
2. **風險評級**（🔴 Critical / 🟡 Warning / 🟢 Good）
3. **具體問題**（如有）
4. **改善建議**（包括實作方向和影響範圍）

最後提供一份**架構改善路線圖**，按優先級排序。
