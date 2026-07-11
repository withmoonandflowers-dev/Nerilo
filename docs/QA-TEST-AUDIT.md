# QA 測試稽核：完整度、欺騙、方法正確性

- 日期：2026-07-05
- 範圍：`tests/unit`（103 檔）+ `tests/e2e`（24 檔），重點在傳輸/加密關鍵路徑
- 方法：對齊 `.claude/skills/harden-tests`（覆蓋率地板、property、mutation、模擬）

## 一句話結論

**測試整體誠實、關鍵傳輸模組（antiEntropy / RecordCrypto）測得紮實；覆蓋率地板已設
（現況 61.83%）。最大歷史風險是「mesh 單元把 crypto/identity mock 掉」——真實 crypto
契約破綻對單元隱形（extractable bug 正是此類），本輪已補真 crypto 整合測試填此洞。**
剩餘唯一系統性缺口：未接自動化 mutation（Stryker）。

## ✅ 做得對的（別動）

| 項目 | 為何是好測試 |
|---|---|
| `antiEntropy.spec` 收斂模擬 | 3 節點**亂序 + 部分遺失**、**鏈狀拓撲（A-C 不相鄰）**下驗「最終各恰好一次」——直接驗不變量，不是走行數 |
| `RecordCrypto.property.spec` | fc.assert × 10：`decrypt(encrypt(x))==x`、密文不外洩明文、異金鑰恆解不開——任意輸入驗不變量 |
| `mesh-diagnostic.spec`（E2E） | 3×3 送達矩陣**全 =1**：`count==1` 同時抓「漏(0)」與「重(≥2)」，比 `toBeVisible` 強；且檔頭有誠實條款（不准加長 timeout 硬湊綠） |
| golden-path / chat-dedup（E2E） | 真實 Chromium + 真 crypto + 模擬器，是真 crypto 契約的唯一守門 |
| skip 率 | 全庫僅 1 個 skip（匿名 auth 環境不支援，理由正當） |

## ⚠️ 欺騙風險 / 完整度缺口（依嚴重度）

### 1（高）mesh 單元 mock 掉 crypto/identity → 真契約破綻對單元隱形
`MeshGossipManager.spec`、`MeshTyping.spec` 用 `vi.mock` 換掉 `SecurityManager` /
`IdentityManager`。後果：**收訊身分驗證的真實 crypto 路徑從沒被單元跑過**。

> **案例（真的發生過）**：`importPublicKey` 曾用 `extractable:false`，使收訊
> `deriveUserId` 的 `exportKey` 擲錯、mesh 訊息全滅。**1207 個單元全綠**卻漏掉——
> 因為單元都拿「可匯出的測試金鑰」繞過。最後靠 E2E（真 crypto）才抓到。

**現況緩解**：已補 `SecurityManager.spec` 的「匯入公鑰必須可 exportKey」回歸 + E2E 網。
**仍缺**：一支**真 crypto 的單元整合測試**，跑「簽名→匯入 pubKey→deriveUserId→
senderId 一致」全鏈，讓此類 bug 在**秒級單元**就紅，不必等分鐘級 E2E。

### 2（中）弱斷言：`toBeTruthy` 於密文
`ChatServiceE2EE.spec` 對 `ciphertext`/`iv` 只斷言 `toBeTruthy()`。這會**放過**
「加密沒真的發生」以外的錯（例：密文其實等於明文、無法解回）。**更強**：斷言
`ciphertext !== plaintext` 且 `decrypt(ciphertext) === plaintext`。

### 3（低）覆蓋率地板已設；未跑 mutation
- **覆蓋率地板已存在**（`vitest.unit.config.mjs` thresholds lines:60/stmts:59，量
  `src/core|services|utils`）。實測現況 **Statements 61.83%（5027/8130）**，在地板之上、
  協議層（已排除 UI）算健康。floor+ratchet 機制**已就位**（原稽核誤判為缺，特此更正）。
- **仍缺 Stryker mutation**：**覆蓋率說「行數跑過」，mutation 才說「測試抓得到 bug」**。
  關鍵模組（`RecordCrypto`、`antiEntropy`、`GossipMessageHandler`、`SecurityManager`）
  值得跑，殺存活 mutant。本輪已用「手動 mutation」示範（把 extractable 翻 false 確認
  新測試會紅），自動化的 Stryker 尚未接。

## 方法學正誤（「測試方式是否正確」）

- **真 vs mock**：mock 快但**藏真契約 bug**。crypto/傳輸這種「契約在真實 runtime 才
  成立」的模組，安全網**必須**有真 crypto 路徑（真 crypto 單元整合測試 或 E2E），
  不能只有 mocked 單元。← 本庫最該補的一層。
- **property 測試不是沒斷言**：naive「grep 無 `expect(`」會**冤枉** property 測試
  （它用 `fc.assert`）。稽核工具要認得 `fc.assert`/`fc.property`。
- **覆蓋率會說謊**：行數 100% ≠ 抓得到 bug（extractable 那行有被跑過）。用 mutation 補驗。
- **分散式測試連跑 3 次**：mesh/rejoin 這類非同步行為，單次綠不代表不 flaky。

## 建議（依優先序，可執行）

1. ✅ **已做**：補真 crypto 單元整合測試（`MeshIdentityContract.spec.ts`，無 mock，
   mutation 驗證會抓 extractable 類 bug）。
2. ✅ **已在**：覆蓋率地板（floor 59/60，現況 61.83%）。之後只升不降。
3. ✅ **已做**：接 **Stryker mutation**（`stryker.conf.mjs`，`npm run test:mutation`），
   兩個關鍵傳輸模組都補過 80% 目標：
   - `antiEntropy.ts`：78.70% → **87.96%**（補 validation.spec 殺 normalizeDigest 分支 + peerLacks floor 守衛）
   - `RecordCrypto.ts`：61.70% → **80.85%**（補 mutation.spec 殺 isEncryptedContent/contentEpoch 偵測分支——盲信使誤判防線）
   剩餘 survivors 多為等價 mutant（不可達的 catch 分支等）。
4. **待做**：強化弱斷言——加密相關的 `toBeTruthy` 改成「密文≠明文 + 可解回」。
5. ✅ **已做**：**確定性模擬**（`antiEntropy.simulation.spec.ts`）——固定 seed、注入
   丟包/亂序/分割，300+ seed 掃「連通圖必收斂」，含反向對照（斷開圖不收斂）證明
   非套套邏輯。分散式協議黃金標準。
6. ✅ **續守**：E2E 誠實條款（exactly-once 矩陣 + 不准加長 timeout 硬湊綠）。

## 專業工具鏈完整度（對照 harden-tests skill）

| 專業做法 | 狀態 |
|---|---|
| 真環境測試（真 crypto，不靠 mock） | ✅ MeshIdentityContract |
| 覆蓋率 floor+ratchet | ✅ 61.83%，floor 59 |
| property-based（fast-check） | ✅ RecordCrypto.property |
| **mutation（Stryker）** | ✅ antiEntropy 87.96% · RecordCrypto 80.85% |
| **deterministic simulation** | ✅ antiEntropy.simulation（seed+故障注入） |
| characterization / E2E 護欄 | ✅ golden-path + exactly-once 矩陣 |

自評：從「稱職但非天花板」補到**接近教科書級**；剩弱斷言強化屬打磨，非缺口。

## 「這測試是否誠實」檢查清單（未來寫測試自問）

- [ ] 有沒有 mock 掉「正要驗的那個契約」？（extractable 類）
- [ ] 把實作內容整段刪掉，這測試還會過嗎？（若會 → 沒抓到東西，用 mutation 驗）
- [ ] 是斷言「行為」還是只斷言「不是 undefined」？（弱斷言）
- [ ] 真實路徑（真 crypto / 真傳輸）有沒有在某處（真單元 或 E2E）被跑過？
- [ ] 分散式/連線的斷言，是否連跑 3 次確認非 flaky？

---

## 附：關於「統一底層傳訊（遊戲/聊天都一樣）」

稽核時確認：統一傳訊層**已在建且測得好**——`antiEntropy.ts`（seq-based digest 對帳，
收斂模擬驗證）、`RecordCrypto.ts`（盲信使密文，property 驗證），對應 ADR-0023/0024。
這正是「不管遊戲或聊天都一樣」的底層方向。**本稽核的價值在確保它被誠實測試**，而非
重造——上面的建議 1/3（真 crypto 整合 + mutation）就是讓這層可信的關鍵。
