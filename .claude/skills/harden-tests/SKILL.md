---
name: harden-tests
description: 提高 Nerilo 測試涵蓋與穩定度、防止改動弄壞運作中路徑的工作流。當使用者要「提高測試覆蓋/穩定度」「加測試」「防迴歸」「改核心/連線/協議/加密程式碼」「重構運作中的路徑」，或要跑覆蓋率/property/mutation/模擬測試時使用。改 P2PConnectionManager、star/mesh、crypto、gossip、RoomService 等既有運作路徑前必用。
---

# harden-tests — 讓改動穩定、覆蓋高、不弄壞既有

本專案是分散式 + 密碼學系統，最貴的錯是**改動弄壞了正在運作的路徑**（本專案已發生兩次：perfect negotiation 弄壞首次連線、看門狗重連不穩定）。覆蓋率會說謊（行數跑過 ≠ 測試抓得到 bug）。這個 skill 把業界最有效的做法固化成流程。工具都用標準品（vitest c8 / fast-check / Stryker / Firebase emulator），不重造輪子。

## 鐵律（誠實條款，優先於一切）

1. **不准加長 timeout 硬湊綠。** 逾時是真訊號。
2. **改動讓事情變糟 → 立刻回退**，回到穩定基準，不留半調子。
3. **紅的釘住測試（characterization）= 停止號誌**，代表你弄壞了既有行為，不是「調測試」。
4. 只動任務範圍內的路徑；動到相鄰路徑要明講並重驗它。

## 改「運作中路徑」的標準流程（characterization-first）

改 `src/core/p2p`、`src/core/mesh`、`src/core/crypto`、`RoomService`、star/mesh 等**現在會動**的東西前：

1. **先釘住現況（characterization / golden-master）**
   - 若這條路現在會動，先寫一支測試「釘住它今天的正確行為」再改。
   - 端到端行為用對應 E2E 當釘子（例：改 P2PConnectionManager 前，先確認
     `tests/e2e/golden-path.spec.ts` P0.4 訊息往返在你的分支上是綠的——那就是首次連線的釘子）。
   - **這一步直接擋住「弄壞首次連線」那類事故**：改完跑釘子，紅了馬上知道。
2. **改動 → 分層迴歸閘門（見下）逐層驗證**，每層綠了才進下一層。
3. **為新行為補測試**，並用下面的「測試品質檢查」確認新測試真的會失敗（不是裝飾）。
4. 全綠才 commit；任一層紅且非預期 → 回退（鐵律 2）。

## 分層迴歸閘門（commit 前，由快到慢）

```bash
# L0 靜態（秒級）
npm run type-check
# L1 受影響單元（秒級）— 只跑改到的模組的 spec，快速迴圈
node ./node_modules/vitest/vitest.mjs run tests/unit/<相關>.spec.ts
# L2 全單元（~10s）
node ./node_modules/vitest/vitest.mjs run tests/unit
# L3 受影響 E2E（分鐘級，需 emulator）— 改連線/房間務必跑
npx firebase emulators:exec --only auth,firestore --project nerilo \
  "npx playwright test --config playwright.vue.config.ts tests/e2e-vue/<相關>.spec.ts --workers=1 --reporter=list"
# 改 @legacy core（React+Vue 共用）務必也跑 React 護欄：
npx firebase emulators:exec --only auth,firestore --project nerilo \
  "npx playwright test tests/e2e/golden-path.spec.ts tests/e2e/mesh-diagnostic.spec.ts --workers=1 --reporter=list"
# L4 全套（合併/發布前）
npm run ci   # type-check + lint + 全單元
```
不確定「受影響」範圍時，寧可多跑一層。分散式行為（mesh/rejoin）**連跑 3 次**確認非 flaky。

## 覆蓋率：地板 + 棘輪（floor + ratchet）

覆蓋率是**地板不是目標**——防「新增未測程式碼」，不是刷數字。

```bash
npm run test:coverage    # v8，text-summary + html（coverage/ 目錄）
```
- 設定在 `vitest.unit.config.mjs`，只量 `src/core|services|utils`（協議層），排除 UI/型別/入口。
- **建立門檻**：先跑一次取現況 → 把 thresholds 設為「現況向下取整」當地板 → 之後只升不降（每次有意義的覆蓋提升就上調地板）。**絕不盲設**未量測的門檻（會讓 CI 意外變紅，違反鐵律）。
- 分母造假防範：新協議/服務檔預設納入 include，別靠排除檔案美化數字。

## property-based（fast-check）— 抓你沒想到的輸入

純函數、密碼學、去重、收斂這類「有普遍不變量」的模組，example 測試不夠。用 fast-check 對任意輸入驗不變量。**樣板**：`tests/unit/RecordCrypto.property.spec.ts`。

適用清單（本專案高價值標的）：
- `RecordCrypto`：`decrypt(encrypt(x))==x`、密文不外洩明文、異金鑰恆解不開、明文不誤判（✅ 已做）。
- `antiEntropy`：任意訊息順序/丟失下，連通圖上必收斂到全員一致。
- `GossipMessageHandler` 去重：`(senderId, seq)` 冪等——任意重送/亂序只顯示一次。

寫法：`fc.assert(fc.asyncProperty(fc.string(), async (x) => <不變量成立>), { numRuns: 100+ })`。失敗時 fast-check 會自動縮小到最小反例。

## mutation testing（Stryker）— 檢查測試「真的會失敗」

覆蓋率說「行數跑過」，mutation 說「測試抓得到 bug」。對高風險模組（crypto、antiEntropy、GossipMessageHandler）值得跑。**按需啟用**（重、慢）：

```bash
npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner
npx stryker init      # 選 vitest runner
# stryker.conf 設 mutate: ['src/core/mesh/antiEntropy.ts', 'src/core/mesh/RecordCrypto.ts', ...]
npx stryker run
```
存活的 mutant = 測試漏洞：那行被改壞了測試卻沒紅。補測試殺掉它。目標對關鍵模組 mutation score ≥ 80%。

## deterministic simulation — 分散式協議的黃金標準（進階，按需）

FoundationDB/TigerBeetle 流派：把真協議跑在**受控的模擬網路**（可注入延遲、丟包、亂序、分割），斷言不變量（收斂、恰好一次）。正中「離開再進」這類 bug。本專案 `antiEntropy.spec.ts` 的「收斂性模擬」已是雛形——擴充成可注入亂序/丟包/節點進出的 harness，用固定 seed 重現失敗。這是最深、最貴，但對 mesh 可靠性回報最高的一層；有連線層難纏 bug 時才投入。

## 產出檢查（收工前自問）

- [ ] 改的是運作中路徑 → 有沒有先釘住現況？改完跑過釘子？
- [ ] 分層閘門逐層綠？改 @legacy core 有跑 React 護欄？
- [ ] 新程式碼有測試，且該測試「真的會失敗」（必要時 mutation 抽驗）？
- [ ] 分散式/連線改動連跑 3 次非 flaky？
- [ ] 覆蓋率沒跌破地板？有意義的提升有上調地板？
- [ ] 全綠才 commit；有弄糟就回退了？
