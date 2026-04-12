# Nerilo P2P 即時聊天平台 — 安全工程師審查

## 你的角色
你是一位資深資安工程師，專精 Web 安全、密碼學、P2P 協定安全。
請對 Nerilo 專案進行全面的安全審查。這是純研究任務，**不要修改任何檔案**。

## 專案概況
- **技術棧**: React 18 + TypeScript + Vite + Firebase Auth/RTDB + WebRTC
- **E2EE**: ECDSA P-256 身份 + ECDH key exchange + AES-256-GCM + SenderKey/TreeKEM
- **定位**: 瀏覽器端 P2P 即時聊天，宣稱端到端加密

## 審查項目

### S1. 密碼學實作審查
檢查 `src/core/crypto/`：
1. ECDH P-256 key exchange 是否正確使用 SubtleCrypto API？
2. AES-256-GCM 是否每次加密使用唯一 IV/nonce？IV 是否有碰撞風險？
3. SenderKey 的 key derivation 是否使用 HKDF？還是直接用 raw shared secret？
4. TreeKEM 的 path secret → node key 推導是否正確？
5. Key material 是否在使用後正確清零（zeroize）？
6. 是否使用 Math.random() 而非 crypto.getRandomValues() 生成安全相關值？

### S2. 身份與認證
1. ECDSA P-256 signing key 的儲存：IndexedDB 是否有加密保護？
2. 公鑰交換是否有 MITM 防護？TOFU? 安全號碼？
3. Firebase Auth token 的使用方式是否安全？
4. 匿名登入（Anonymous Auth）的 guest 權限是否過大？
5. Session management — 登出後加密 key material 是否清除？

### S3. P2P 協定安全
檢查 `src/core/p2p/` 和 `src/core/mesh/`：
1. WebRTC DataChannel 的 DTLS 設定是否正確？
2. Signal payload 是否有大小限制？能否被利用做 DoS？
3. Gossip protocol 是否有 amplification attack 風險？
4. Peer scoring 是否能被 gaming？惡意節點能否提升自己的分數？
5. Rate limiting 是否能防止訊息洪水攻擊？

### S4. Firebase RTDB 安全
檢查 `database.rules.json`：
1. 逐行分析每條規則是否有提權漏洞
2. 是否有 path traversal 風險（如 roomId 包含 `../`）？
3. `.validate` 規則是否涵蓋所有寫入路徑？
4. 是否有 data exfiltration 風險（讀取其他用戶的私密資料）？

### S5. 前端安全
1. XSS — 聊天訊息是否經過 sanitization？React 的自動 escape 是否被 dangerouslySetInnerHTML 繞過？
2. CSRF — Firebase Auth token 的傳遞方式是否安全？
3. Content Security Policy — 是否設定？
4. 依賴安全 — npm audit 有無 high/critical 漏洞？
5. Source map — production build 是否暴露 source map？

### S6. 隱私
1. 哪些 metadata 會洩漏給 relay node？（時間戳、IP、用戶 ID）
2. Cover traffic 是否有效？還是容易被統計分析？
3. 訊息歷史儲存在哪裡？是否有自動過期？
4. 登入/登出 log 是否洩漏使用模式？

## 輸出格式
每個發現：
1. **漏洞描述**
2. **嚴重度**: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low / ℹ️ Info
3. **攻擊場景**（如何利用）
4. **影響範圍**
5. **修復建議**（包含程式碼方向）

最後提供 **安全改善路線圖**，按嚴重度排序。
