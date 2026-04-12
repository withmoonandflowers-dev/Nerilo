# Nerilo 穩定性測試生成器

## 你的角色
你是一位資深 QA 自動化工程師，負責為 Nerilo 產生全面的穩定性測試。
你必須**實際撰寫測試檔案**（使用 Write 工具），不只是列出建議。

## 執行步驟

### Step 1：掃描現有覆蓋
```bash
# 列出所有測試檔案
ls tests/unit/

# 列出所有核心模組
ls src/core/game/sdk/
ls src/core/crypto/
ls src/core/relay/
ls src/core/mesh/
ls src/core/p2p/
ls src/core/transport/
```

對比兩邊，找出**沒有測試的核心模組**。

### Step 2：優先級排序
根據以下標準排序缺口：
- P0：安全相關（crypto, security, identity）
- P0：遊戲 SDK（ECS, sync, session, RNG）
- P1：網路韌性（reconnect, fallback, timeout）
- P1：資料一致性（ledger, chain, ordering）
- P2：UI 邏輯（hooks, context）

### Step 3：撰寫測試（每個檔案都要實際建立）

必須撰寫的測試檔案：

#### tests/unit/GameTransportSDK.spec.ts
```
- createSession → 建立 session + world + inputBuffer + syncManager
- registerSystem → 系統註冊 + 執行順序
- submitLocalInput → input 加入 buffer + 廣播
- start/stop → game loop 正確啟動/停止
- saveState/loadState → IndexedDB round-trip
- destroy → 所有資源清理
```

#### tests/unit/GameSession.spec.ts
```
- 狀態機：lobby → playing → paused → playing → ended
- 無效轉移：playing → lobby（應被忽略）
- addPeer/removePeer → 正確更新 peers map
- addPeer 超過 maxPlayers → return false
- electNewHost → 永遠是最小 peerId
- electNewHost 在 3 人斷 2 人的場景
- handleHostDisconnect → 自動 migration + event emit
- commitSeed + receiveReveal → 正確 XOR 種子
- 偽造 reveal（hash 不匹配）→ return null
- serialize/deserialize round-trip
```

#### tests/unit/DeterministicRNG.spec.ts
```
- 同 seed → 同序列（100 次 next()）
- 不同 seed → 不同序列
- fromState → 恢復後序列一致
- fastForward → 等效於逐步呼叫 N 次
- nextInt 分布均勻性（1000 次，chi-squared 基本檢查）
- nextBool(0.5) → 約 50% true（1000 次）
- shuffle → 確定性（同 seed 同結果）
- shuffle → 不改變原始陣列長度
```

#### tests/unit/GameStateStore.spec.ts
```
- saveSnapshot → loadLatestSnapshot round-trip
- saveRNGState → loadRNGState round-trip
- saveSessionMeta → loadSessionMeta round-trip
- clear → 所有 key 被刪除
- loadLatestSnapshot 無資料 → return null
```

#### tests/unit/GameFeature.spec.ts
```
- 每種 message type（13 種）的 dispatch
- 無效 payload → logger.warn + 不 dispatch
- setup/teardown lifecycle
- onPeerLeave → 觸發 onSessionLeave callback
```

#### tests/unit/ECDHKeyExchange.spec.ts (擴充現有)
```
- deriveSharedSecret → sharedBits 被清零驗證
- 同一對 key pair → 兩端推導出相同 shared secret
- encryptForPeer + decryptFromPeer round-trip
- 篡改 ciphertext → decrypt 失敗
- IV 唯一性（連續 100 次加密，IV 不重複）
```

### Step 4：驗證

撰寫完所有測試後：
```bash
node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/vitest/vitest.mjs run
```

確保：
1. TypeScript 零錯誤
2. 所有新測試通過
3. 所有舊測試仍通過
4. 總測試數顯著增加

### Step 5：報告

```markdown
## 測試生成報告
- 新增測試檔案：X 個
- 新增測試案例：Y 個
- 總測試數：Z 個（從 N 增加）
- 所有通過：✅ / ❌
- 覆蓋的新模組：[列表]
- 仍缺覆蓋的模組：[列表]
```

## 測試規範
- 使用 Vitest（import from 'vitest'）
- 標記 `@vitest-environment node`
- 用 `vi.fn()` 做 mock
- 用 `crypto.subtle` 做真實密碼學測試（不 mock SubtleCrypto）
- 遵循現有測試風格（看 tests/unit/ChatFeature.spec.ts 作為範例）
