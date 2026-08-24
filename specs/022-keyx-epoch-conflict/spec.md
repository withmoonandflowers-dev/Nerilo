# Spec 022：偵測同代異鑰並停止靜默覆寫

- 軌別：feature
- 狀態：done（2026-08-24 實作完成，V1-V7 驗收過）
- 建立：2026-08-22／最後更新：2026-08-22
- 關聯：ADR-0023（keyx 分發）、Spec 012（mesh 群組 E2EE）、Spec 018（產生方交接閘門）、B5 稽核項

## 1. 要做什麼、為什麼（specify）

房間成員在同一個內容金鑰 epoch 上，可能收到兩把**不同**的房間金鑰。現況是後到的直接覆寫先到的，且不留任何痕跡：

```ts
// RoomContentKeys.ts
private keyRing: Map<number, CryptoKey> = new Map();   // 只以 epoch 為鍵
setContentKey(key, epoch) {
  const isNew = !this.keyRing.has(epoch);
  this.keyRing.set(epoch, key);          // 同 epoch 後到覆寫
  if (isNew && this.onKeyInstalled) ...  // 覆寫時連補顯示都不觸發
}
```

後果是房間**靜默分裂**：成員依 keyx 到達順序各自持有不同的金鑰，A 群在該 epoch 加密的訊息，B 群永遠解不開，畫面停在鎖頭圖示。因為 `isNew` 為 false，金鑰晚到補顯示（`onKeyInstalled` → `redisplayForKeyEpoch`）不會觸發，所以**不會自癒**，要等下一次換代才可能恢復。使用者看到的是「有些訊息就是讀不到」，而日誌裡沒有任何線索指向真正的原因。

雙產生方目前由三道閘門共同防止（全員 ecdh 就緒、名冊連續穩定、完整名冊最小者）。這個 spec 不改那些閘門，而是補上**它們失守時的安全網**：讓衝突可被偵測、可被診斷、且失敗方式從「靜默永久分裂」變成誠實可見。〔C2 拍板追加〕並讓房間主動收斂——偵測到衝突就請求分發新的一代，而不是停在分裂狀態等下一次名冊變動。

沒有它會怎樣：

1. 任何導致雙產生方的缺陷（名冊視圖分歧、跨時間交接、未來的重構失誤）都會以最難查的形式現身。
2. 更直接的影響是它擋住了另一項工作：閘門 1 沒有逃生窗，一位遲遲不註冊 mesh 身分的 participant 就能讓整房停在「必須確認明文」（B5 已證實，`tests/unit/RoomKeyCoordinator.spec.ts`）。加逃生窗會提高雙產生方機率，而現在**沒有網子接得住**。先有偵測，逃生窗才是負擔得起的選項。

**憲法檢核**（constitution.md）：

- 目標函數加分項：**隱私韌性**（E2EE 的失敗必須誠實可見，不得靜默降級成「部分成員讀不到」）＋**可維運**（現場可診斷）。
- 四條不變量影響：
  - 恰好一次：**間接有影響**。gossip 層的遞送保證不變（訊息仍恰好一次抵達並落盤），但收端永久無法解讀等同於使用者眼中的遺失。本 spec 不改遞送語義。
  - E2EE 機密性：**有影響（正向）**。不改密碼學原語與封裝方式；改的是「同代出現第二把鑰」時的處置，從靜默覆寫改為可偵測。機密性不放寬：任何情況都不得因衝突而以較弱方式加密或退明文。
  - 點數帳本正當性：無影響。
  - 身分與授權：無影響。鑑別衝突所需的產生方身分取自 `GossipMessage.senderId`，該欄位已受簽章覆蓋並經 `deriveUserId(pubKey) === senderId` 綁定驗證（`GossipMessageHandler`），本 spec 不新增信任假設。

## 2. 邊界（明確不做）

- 不改 keyx 的線上格式。鑑別衝突所需的資訊（產生方身分）已在既有已簽章欄位內，本 spec 不新增或修改任何 wire 欄位。
- 不改三道分發閘門，也不在本 spec 加閘門 1 的逃生窗。逃生窗是後續獨立工作，本 spec 只負責先把網子架好。
- 不定義跨實作的確定性裁決規則（C1 拍板：維持 feature 軌）。本 spec 的「先到勝出」是**本機**收斂策略，不承諾兩個不同實作會選到同一把。
- 不改 `RoomKeyCoordinator` 的產生方選舉與三道閘門。〔C2 拍板後修訂〕會新增一個「請求重新分發」的入口，但誰有資格分發仍完全由既有閘門決定。
- 不處理跨 epoch 的金鑰輪替語義（既有行為維持：送出用最高 epoch、解密按信封 epoch 選鑰）。
- 不做遙測上報。衝突只在本機日誌與狀態查詢中呈現。

## 3. 待釐清（clarify）

全部已拍板（2026-08-22），結論併入第 1、4 節：

- [x] C1：**維持 feature 軌**。只做收端偵測與本機收斂，不定義跨實作裁決規則，因此不需版本、相容策略與 conformance 向量。
- [x] C2：**先到勝出＋主動要求換代**。先安裝的金鑰繼續有效，後到的不同金鑰被拒絕並記錄；同時請求協調器分發新 epoch，讓房間主動收斂而不是停在分裂狀態。
- [x] C3：**橫幅＋透出狀態查詢**。沿用既有 `chat__e2ee-warn` 常駐提示，並比照 `getKeyxStatus()` 開一個查詢介面供上層與測試讀取。
- [x] C4：**維持已顯示的明文，不倒退**。已用先到金鑰解出並落盤的訊息保持原樣；不把已讀到的內容改回鎖頭。

## 4. 技術計畫（plan）

### 4.1 金鑰環改記「這一代的鑰是誰發的」

`RoomContentKeyRing.keyRing` 由 `Map<number, CryptoKey>` 改為記錄產生方身分：

```
Map<number, { key: CryptoKey; producer: string }>
```

`producer` 取自 `GossipMessage.senderId`。選它當鑑別依據的理由：該欄位已在簽章覆蓋範圍內，且 `GossipMessageHandler` 驗簽時另外驗過 `deriveUserId(pubKey) === senderId`，所以它是**已經被密碼學綁定的身分**，不需新增任何 wire 欄位，也不需新增信任假設。

**為何不比對金鑰材料**：`generateRoomKey()` 產生的是 `extractable: true` 的金鑰，理論上可匯出原始位元組逐位元比對，鑑別更精確（連「同一產生方在同代發出不同鑰」都抓得到）。但匯出是非同步的，`setContentKey` 目前是同步方法，改成非同步會擴散到所有呼叫端（含 hydrate 重放路徑）。代價與收益不成比例：同一產生方在同代發不同鑰，已被協調器的 `distributedRosterSig` 冪等守衛擋住。故以產生方身分為準，並把這個殘留寫進註解。

### 4.2 安裝語義：三種情況

`setContentKey(key, epoch, producer)` 的處置：

| 情況 | 處置 |
|---|---|
| 該 epoch 尚無金鑰 | 安裝，觸發 `onKeyInstalled`（既有行為不變） |
| 同 epoch、同產生方 | 冪等 no-op。hydrate 會重放全部歷史 keyx，同一筆紀錄重放多次必須無副作用 |
| 同 epoch、**不同**產生方 | **拒絕後到者**，先到的金鑰不動；記錄衝突；請求換代（見 4.3） |

`setContentKey(null)` 清空整個環的既有語義不變（退明文），一併清掉衝突記錄。

### 4.3 主動換代（C2）

偵測到衝突時，通知 `RoomKeyCoordinator` 重新分發：清掉 `distributedRosterSig`，使下一輪 tick 視同「名冊需要重發」，以 `max(已知, 已觀察) + 1` 分發新 epoch。

這條路徑**不需要新的協議訊息**：雙產生方各自送出的 keyx 都會經 gossip 到達彼此，所以兩邊都會偵測到同一個衝突。誰真的重發完全由既有閘門 3（完整穩定名冊的最小者）決定，只有一個節點會動作，房間收斂到單一的新 epoch。

兩道防失控措施：

1. **每個 epoch 只請求一次**：以已請求過的 epoch 集合去重。hydrate 重放歷史衝突時不會反覆觸發。
2. **每個會話設請求上限**：若名冊視圖持續分歧，換代可能在新 epoch 再次衝突。達上限後停止請求，只保留偵測與回報，避免無界換代風暴。上限用盡屬於「需要人介入」的狀態，日誌與狀態查詢都要看得出來。

### 4.4 既有訊息不倒退（C4）

不觸碰 `chatStorage`，也不對衝突 epoch 做任何重新呈現。已用先到金鑰解出並顯示的訊息維持原樣；解不開的維持鎖頭（與現況一致）。本 spec 不讓任何已讀到的內容從畫面上消失。

### 4.5 對外呈現（C3）

- **日誌**：偵測到衝突即以 `logger.warn` 記錄 epoch、先到與後到的產生方 senderId、是否已請求換代。第 1 節指認的病灶之一就是「日誌裡沒有線索」，這條是方案的一部分而非附帶效果。每個 epoch 只吼一次（與換代請求共用去重集合），避免 hydrate 重放洗版。
- `RoomContentKeyRing` 開 `getKeyConflicts()`，回報衝突的 epoch 清單與是否已達換代請求上限。
- 沿 `MeshGossipManager` → `MeshChatService` 透出，比照剛完成的 `getKeyxStatus()` 走法。
- Vue 聊天頁沿用既有 `chat__e2ee-warn` 常駐橫幅，文案說明此房金鑰不一致、部分訊息無法讀取。

### 4.6 動到的模組

`src/core/mesh/RoomContentKeys.ts`（⚠ 運作中的 E2EE 路徑）、`src/core/mesh/RoomKeyCoordinator.ts`（新增重發入口）、`src/core/mesh/MeshGossipManager.ts`、`src/core/messaging/MeshChatService.ts`、`web-vue/app/pages/chat/[roomId].vue`。

注意：`MeshGossipManager` 目前 799 行、上限 800；聊天頁基線 1160。兩者都幾乎沒有餘裕，透出與 UI 的部分**必須以 composable／獨立模組承載**，不得直接把行數加在這兩個檔案上。

## 5. 任務分解（tasks）

- [x] T1 ⚠：characterization 先釘現況（後到覆寫＋先到密文解不開＋不觸發補顯示），綠後才動手；舊行為存 git 歷史。
- [x] T2 ⚠：金鑰環改存 `{ key, producer }`，三種安裝語義落地；`consumeKeyx` 傳 senderId；applyLocalKey 路徑 producer 預設本機 userId。
- [x] T3：`getKeyConflicts()`＋衝突記錄＋每 epoch 一次告警（與換代請求共用去重）。
- [x] T4：`requestRedistribution()`（清 distributedRosterSig）；頻控（per-epoch 去重＋會話上限 3）放金鑰環。
- [x] T5：查詢經既有 `getContentKeyRing()` 直達（MeshChatService.getKeyConflicts 一方法）；manager 僅 1 行接線，行數閘門守住（818/819）。
- [x] T6：useKeyConflicts composable＋ChatWarnNotices 元件（順帶把三條既有橫幅抽出，聊天頁 1159→1150 反向縮；data-testid 原樣保留）。
- [x] T7：QA-REPORT 已知限制回填（含 4.1 殘留）。

## 6. 驗收（黃金判準）

- [x] V1：同 epoch、同產生方重複安裝 → 冪等，不記為衝突，不重複觸發補顯示（釘住 hydrate 重放路徑）。
- [x] V2：同 epoch、不同產生方 → 先到的金鑰仍可解密先到方的訊息；後到的被拒絕；`getKeyConflicts()` 回報該 epoch。
- [x] V3：衝突發生後，協調器在下一輪 tick 以更高的 epoch 重新分發；且同一個 epoch 的衝突只請求一次。
- [x] V4：達會話上限後不再請求換代，但衝突狀態仍如實回報。
- [x] V5：既有訊息不倒退——衝突前已解出的訊息，在衝突發生後仍以明文呈現（C4）。
- [x] V6：`setContentKey(null)` 清環時一併清掉衝突記錄，回到乾淨狀態。
- [x] V6b：衝突被記錄到日誌且含兩位產生方的 senderId；同一 epoch 重放多次只記錄一次（證明第 1 節的「無跡可循」已被解決，而不只是內部狀態變了）。
- [x] V7：全單元 1699 綠（連 5 輪）＋@vue-stable 11/11（emulator 4.9m）；行數閘門 manager 818/819、聊天頁 1150/1160。

## 7. 一致性自查（analyze，implement 前跑一次）

2026-08-22 執行，抓到兩個缺口並已修補：

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做
  - **修補**：第 1 節把「日誌裡沒有線索」列為病灶，第 4 節原本卻沒把日誌當方案的一部分（只在 4.3 順帶提到）。已於 4.5 明列並補 T3。
  - **修補**：C2 的「主動換代」原本只出現在第 3、4 節，第 1 節的需求敘述沒提到收斂目標，方案與需求對不起來。已於第 1 節補記。
- [x] 第 5 節任務完整實現第 4 節，無遺漏
  - 4.4（不倒退）是「不做某事」，無對應任務屬正常；由 V5 把關。
- [x] 第 6 節驗收能證明第 1 節，不是只證明「程式跑得動」
  - **修補**：原本沒有任何一條在證明「現場可診斷」，只有 V7 這種「跑得動」型閘門。已補 V6b。
- [x] 未違反憲法任何一條
  - 第 4 條（四不變量聲明）：第 1 節已逐條交代，含「無影響」者。
  - 第 6 條（改運作中路徑走 characterization-first）：T1 為 ⚠ 前置任務，T2 同標 ⚠。
  - 第 10 條（已知邊界自我揭露）：4.1 的「不比對金鑰材料」殘留要寫進程式註解，T7 回填風險登記。
  - 第 15 條（雙軌）：C1 已拍板 feature 軌，故不需版本/相容策略/conformance 向量。
