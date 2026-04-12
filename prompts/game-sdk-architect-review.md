# Nerilo Game Transport SDK — 架構師審查

## 你的角色
你是一位資深遊戲引擎架構師，專精 P2P 多人遊戲、ECS 架構、rollback netcode。
請對 Game Transport SDK 進行全面審查。這是純研究任務，**不要修改任何檔案**。

## 審查範圍

### G1. ECS 架構 (`src/core/game/World.ts`)
1. Structure-of-Arrays vs Array-of-Structures — 當前 SoA 實作的效能特性
2. Bitmask archetype 上限（31 個 component types）是否足夠？
3. Delta tracking 的正確性 — dirty 標記是否在 snapshot/restore 後正確重置？
4. Query cache invalidation — 新增/移除 component 後 cache 是否正確失效？
5. `takeSnapshot()` / `restoreSnapshot()` 是否完全可逆（round-trip 不丟資料）？

### G2. Lockstep + Rollback (`src/core/game/NetworkSyncManager.ts`)
1. `advanceTick()` 是否正確處理：input 全到 → confirm tick, 部分到 → predict, 全缺 → pause?
2. Rollback 流程：找 snapshot → restore → resimulate — 是否遺漏任何 side effect？
3. Prediction overflow (`maxPredictionAhead=8`) 時是否正確暫停？
4. State hash (FNV-1a) 是否足夠偵測 desync？碰撞率？
5. `onRemoteInputReceived()` 處理 late input 的 mismatch 偵測是否有 race condition？

### G3. Input 系統 (`src/core/game/InputBuffer.ts`)
1. Ring buffer 滿時（>128 ticks）是否正確淘汰最舊的 tick？
2. `getOrPredict()` 的預測策略是否合理？（repeat last known input）
3. `inputDelay` 的數學是否正確？本地 tick + delay = effective tick?
4. 多人同步時，是否可能出現某 peer 的 input 永遠缺失（peer crash）？如何處理？

### G4. GameTransportSDK (`src/core/game/sdk/GameTransportSDK.ts`)
1. SDK 自己管理的 rAF loop 是否正確處理了 spiral of death？
2. `submitLocalInput()` → `inputBuffer.addLocalInput()` → broadcast 的時序是否正確？
3. `saveState()` 的持久化頻率（每 100 confirmed ticks）是否合理？
4. `loadState()` 恢復後，syncManager 和 validator 的內部狀態是否一致？

### G5. GameSession (`src/core/game/sdk/GameSession.ts`)
1. Host migration（lowest peerId）是否在所有 edge case 下正確？（同時斷線、重連）
2. Hash-then-reveal seed negotiation 是否抗攻擊？（last submitter bias, selective abort）
3. Session state machine 轉移是否嚴謹？（是否可能 playing → lobby？）
4. `serialize()` / `deserialize()` round-trip 是否完整？

### G6. DeterministicRNG (`src/core/game/sdk/DeterministicRNG.ts`)
1. xorshift128+ 的品質：週期、分布、碰撞率
2. `fromState()` + `fastForward()` 是否保證與原始序列一致？
3. Warmup（20 次）是否足夠消除初始偏差？
4. `nextInt()` 是否有 modulo bias？

### G7. 伺服器獨立性驗證
1. 在 Firebase RTDB 完全不可用的情況下，哪些功能仍可正常運作？
2. 在 TURN server 不可用的情況下，哪些 NAT 類型的使用者無法連線？
3. 在 IndexedDB 被清除的情況下，`loadState()` 的 fallback 行為是否安全？

## 輸出格式
每個審查項目：
1. **現狀**（1-2 句）
2. **風險**: 🔴 Critical / 🟡 Warning / 🟢 Good
3. **問題**（如有）
4. **修復建議**（包含程式碼方向）

最後：**Game SDK 上線 Checklist**（必須全部通過才能讓遊戲開發者使用）
