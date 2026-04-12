# Nerilo 密碼學與安全深度審計

## 你的角色
你是一位資深密碼學工程師 + 滲透測試專家。
請對 Nerilo 的所有安全相關程式碼進行逐行審計。這是純研究任務，**不要修改任何檔案**。

## 審計範圍

### C1. ECDH Key Exchange (`src/core/crypto/ECDHKeyExchange.ts`)
逐行審查：
1. `deriveSharedSecret()` — ECDH → HKDF → AES-256-GCM 的完整鏈
2. HKDF salt 是否為靜態？是否應使用隨機 salt + session nonce？
3. `sharedBits` 是否在 HKDF 導入後被清零（zeroization）？
4. `encryptForPeer()` 的 IV 是否每次隨機？是否使用 `crypto.getRandomValues()`？
5. IV 重用風險分析：AES-GCM 同一 key + 同一 IV = 完全失密

### C2. SenderKeyManager (`src/core/crypto/SenderKeyManager.ts`)
逐行審查：
1. `generateSenderKey()` — AES-256-GCM key 是否用 SubtleCrypto 生成？extractable 設定？
2. `encryptMessage()` — seq counter 溢出行為（Number.MAX_SAFE_INTEGER 後？）
3. `decryptMessage()` — seq 驗證是否嚴格遞增？是否可被 bypass？
4. `distributeSenderKey()` — per-member ECDH 加密是否正確？key 是否洩漏到非預期接收者？
5. `checkAutoRotation()` — rotation 觸發後，舊 key 的生命週期管理
6. `previousPeerKeys` — 只保留 1 代是否足夠？高延遲網路場景？
7. `destroy()` — CryptoKey 物件是否能被 GC 回收？ArrayBuffer 殘留？

### C3. TreeKEMManager (`src/core/crypto/TreeKEMManager.ts`)
逐行審查：
1. 二元樹結構是否正確（left-balanced binary tree）？
2. `updatePath()` — 是否匯出 PKCS8 私鑰？這比傳輸 path secret 風險更高
3. `encryptMessage()` — 是否有 replay protection（seq counter）？
4. leaf-to-root 路徑更新是否正確加密每個 co-path sibling？
5. Member add/remove 後 tree rebuild 是否保持一致性？
6. extractable key 的安全影響（XSS 可 exportKey）

### C4. GroupKeyManager (`src/core/crypto/GroupKeyManager.ts`)
1. SenderKey ↔ TreeKEM 切換邊界（50）和 hysteresis（40 降級）是否合理？
2. 切換過程中的 in-flight 訊息是否能正確解密？
3. 統一 API 是否隱藏了兩種策略的行為差異？

### C5. SecurityManager (`src/core/mesh/SecurityManager.ts`)
1. ECDSA P-256 簽名的 hash 演算法是否正確（SHA-256）？
2. 時間戳驗證：MAX_MESSAGE_AGE_MS=5min, 未來容忍=30s — 是否足夠？
3. `importPublicKey()` — Base64 解碼失敗的錯誤處理

### C6. IdentityManager (`src/core/mesh/IdentityManager.ts`)
1. ECDSA key pair 以 PKCS8 Base64 存在 IndexedDB — XSS 風險分析
2. `extractable: true` 用於匯出到 IndexedDB — 是否可改為 wrapKey/unwrapKey？
3. `deriveUserId()` — userId 從 pubKey 推導的碰撞風險

### C7. Sphinx Onion Routing (`src/core/relay/SphinxPacket.ts`)
1. 每跳 ephemeral ECDH key 是否正確生成和使用？
2. MAC 驗證是否在解密前執行（Encrypt-then-MAC）？
3. 固定封包大小（4096 bytes）是否在所有路徑上保持一致？
4. Header 和 payload 的加密是否獨立（防止交叉洩漏）？

### C8. RTDB Security Rules (`database.rules.json`)
逐行審查每條規則：
1. 是否有提權路徑？（participant → owner）
2. `from === auth.uid` 是否在所有寫入路徑中強制？
3. `.validate` 規則是否涵蓋所有欄位？
4. 是否有未保護的路徑（wildcard `$other`）？
5. roomRequests 的防偽造和防覆寫是否完整？

### C9. P2P 協定安全
1. P2PChannelBus 的 64KB 訊息限制是否足夠？
2. Signal payload 的 10KB 限制（RTDB rules）是否足夠？
3. GossipMessageHandler 的 CSPRNG shuffle 是否正確實作？
4. Cover traffic 的 CSPRNG Poisson timing 是否能抵抗統計分析？
5. Rate limiter 的滑動窗口參數是否合理？

### C10. Game SDK 安全
1. DeterministicRNG 的 seed negotiation（hash-then-reveal）是否抗攻擊？
2. GameStateValidator 的 hash voting 是否能偵測單一作弊者？
3. Host migration 的 deterministic election 是否可被操縱？
4. GameFeature 的 payload validation 是否完整？

## 輸出格式

### 漏洞報告表
| # | 模組 | 嚴重度 | 描述 | 攻擊場景 | 修復建議 |
|---|------|--------|------|---------|---------|

### 密碼學正確性評估
| 原語 | 實作 | 評估 | 備註 |
|------|------|------|------|

### 上線前安全 Checklist
- [ ] 所有 Critical 漏洞已修復
- [ ] 所有 High 漏洞已修復或有明確緩解措施
- [ ] Key material lifecycle 完整（生成→使用→清零）
- [ ] RTDB rules 無提權路徑
- [ ] 所有 Math.random 已替換為 CSPRNG
