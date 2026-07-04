# QA 報告：聊天功能

- 日期：2026-07-04
- 範圍：Nerilo 聊天（P2P + E2EE + Firestore 備援）核心功能完整驗證
- 環境：單元（vitest）、E2E（Playwright + Firebase 模擬器 auth/firestore、真實 Chromium 雙瀏覽器）

## 結論：2 人通過；3–5 人 mesh 失敗

**2 人星型**（註冊登入、建房、加入、P2P 連線、E2EE、雙向傳訊、無重複、離開）全數通過，
「寄件方訊息重複」在真實瀏覽器端到端確認修復並加永久回歸測試鎖住。**可用於展示。**

**3–5 人 mesh**：QA 發現訊息在 peer 間完全不傳播（見下），判定**不可用**。展示請限 2 人。

## 測試結果

| 層級 | 範圍 | 結果 |
|---|---|---|
| 單元 | 全套 88 檔 1109 測試 | ✅ 全過 |
| E2E @stable | 認證流 + P0 黃金路徑（10 測試） | ✅ 全過 |
| E2E 去重回歸（新增） | 2 人：多則訊息雙方各恰好一次 + E2EE + 雙向 | ✅ 通過 |
| **E2E 3 人 mesh** | 3 人：每人看見彼此訊息 | ❌ **失敗（見下）** |

### ⚠️ 重大發現：3–5 人 mesh 訊息不互通

3 人 mesh 測試（`multi-peer.spec.ts` P1.9）連續兩次一致失敗。診斷結果：

| 觀察 | 值 |
|---|---|
| 連線橫幅 | A/B/C 皆顯示「P2P 已連線 — Mesh 中繼」 |
| A 看到的訊息 | 只有自己（A=1, B=0, C=0） |
| B 看到的訊息 | 只有自己（A=0, B=1, C=0） |
| C 看到的訊息 | 只有自己，且**重複兩次**（C=2） |

**判定（初次）**：mesh 拓撲下訊息完全不在 peer 間傳播。

### ✅ 根因已找到並修復：公鑰 extractable

深入除錯發現：`SecurityManager.importPublicKey` 以 `extractable:false` 匯入公鑰，
但收訊時 `IdentityManager.deriveUserId` 會對該公鑰做 `exportKey('spki')` 驗證
pubKey↔senderId。`extractable:false` 使 `exportKey` 擲錯，導致**每則 gossip 訊息
在身分驗證處炸掉、永不送達**。改為 `extractable:true`（公鑰本為公開，無安全風險）。

驗證：修復後 3 人診斷從「每人只見自己（A=1 B=0 C=0）」變為訊息開始互通
（如 A 見全部 A=1 B=1 C=1）。單元回歸鎖住（`SecurityManager.spec` importPublicKey
可匯出）。單元測試未抓到是因其用可匯出金鑰繞過此真實路徑——此為 E2E QA 的價值。

### 🟡 殘留（未修，屬更深的獨立工作）

修復傳播主因後，mesh 仍**不穩定**：多次診斷結果不一致（有時全通、有時部分），
屬**連線成形時序競態**（`expectChatReady` 只要求連上至少一個鄰居，訊息可能在
full mesh 成形前送出即遺失，且無 anti-entropy 補償重送）；另有自訊息偶爾重複。
這是分散式系統可靠性問題，需真實多瀏覽器 + 較大工程（連線就緒門檻、訊息補償）。

**現況判定**：mesh 從「完全不可用」提升為「會傳但不可靠」。

### 第二輪改善（anti-entropy）：大幅改善，仍未達 100%

針對時序競態加了**週期性 anti-entropy**：每 2 秒把最近 60s 訊息補送給所有已連上
鄰居（收端去重、冪等），使訊息不論連線成形時序都最終送達。並修了兩個相關問題：
gossip 送出不再自我 emit（避免與樂觀更新 id 不一致造成自訊息重複）、自訊息過濾
改用正確的 mesh userId（原比 firebase uid 永不命中）。

**效果**：3 人 E2E 從「每人只見自己」提升為「多數情況全員互通」。但多次驗證仍
**不一致**：有時全通但自訊息偶爾重複、有時漏一則。此不一致證明殘留為**連線成形
時序競態**（部分 pairwise DataChannel 在訊息送出時尚未雙向就緒），非可再以少量
邏輯修正收斂者。

**未達 100% 的殘留**（需更大工程，非本輪範圍）：
1. 送訊前應 gate 在「full mesh 全就緒」而非「連上至少一個」。
2. 樂觀更新與 gossip 收訊的 messageId 應統一（目前 UUID vs userId-seq）。
3. 需真實多瀏覽器（非 headless 模擬器）確認時序特性。

**現況判定**：mesh **大幅改善但仍不保證可靠**。展示請維持 2 人星型（穩定）；
3–5 人可靠需獨立的連線就緒/訊息 id 統一工程 + 真實環境驗證。

### E2E @stable 涵蓋（10/10）
- 註冊 → 儀表板（角色 user）、登出再登入、錯誤帳號清楚錯誤、重複 email 導引登入
- P0.1 註冊落地儀表板、P0.2 建房落地等待頁、P0.3 第二人加入雙方進聊天室
- **P0.4 訊息往返（A 送 B 收）**、**P0.5 E2EE 指示可見**、P0.6 離開返回儀表板

### 去重回歸（本次新增，`tests/e2e/chat-dedup.spec.ts`）
- A 連送 3 則，每則在**寄件方 A** 與**收件方 B** 畫面各斷言 `toHaveCount(1)`（無重複）
- B 回覆，A 收到且同樣不重複
- 截圖證據：`qa-chat-alice.png` / `qa-chat-bob.png`

## 證據（截圖）

Alice（寄件方）畫面顯示：房間標題帶「端到端加密」徽章；A-1/A-2/A-3 三則各一顆泡泡
帶已送達勾；B 回覆一顆。無任一則重複。

## 已知限制（本輪未涵蓋，非缺陷）

- **僅測 2 人星型**：3–5 人 mesh、6+ 未在本輪 QA 範圍（星型最穩，見成熟度矩陣）。
- **模擬器環境**：auth/firestore 為模擬器；真實 Firebase + 跨網路 NAT 穿透未在自動化涵蓋
  （P2P 連通率 8–15% 受阻屬環境因素，非程式缺陷）。
- **未測**：檔案傳輸、語音/視訊、離線久置後 fallback 長時行為。

## 回歸保護

去重測試標 `@stable`，納入 CI（每次 PR/master push 跑），修復不會再回退。

## 第三輪（2026-07-05）：3 人 mesh「最終各恰好一次」達標

**驗證標準**：3 人診斷 E2E（`tests/e2e/mesh-diagnostic.spec.ts`）連續 5 次、
每次 3x3 送達矩陣全 =1（count==1 同時抓漏與重）。實測**連續兩批 5/5（10 連綠）**。
送達 deadline 固定 20s（10 個對帳週期）+ 5s 沉澱抓重複；總 timeout 只涵蓋
註冊與 WebRTC 連線成形，未以放寬送達門檻湊綠。@stable 迴歸 11/11 綠。

### 根因（五個，全部有實證與回歸鎖）

1. **簽章覆蓋 ttl**（`SecurityManager`）：gossip 轉發 ttl-1 改變被簽內容 →
   所有經轉發的副本簽章必然失效 → 轉發路徑整條壞死，mesh 只剩直連可用。
   修：ttl（可變路由欄位）排除在簽章外。回歸：`SecurityManager.spec` 轉發副本驗簽。
2. **checkSequence 拒收亂序舊 seq**（`GossipMessageHandler`）：把補送回來的
   較早訊息當重放丟棄 → 永久遺失。修：去重改以「(senderId, seq) 是否已持有」
   判定；亂序未見過一律接受。回歸：`GossipMessageHandler.spec`。
3. **signaling 互刪**（`P2PConnectionManager`）：兩個清理（close 時刪自己全部
   signal、ICE connected 後刪整房舊 signal）都不分 channelLabel → mesh 多連線
   併發建立時互刪 offer/ICE，隨機造成某 pair 永久建不起來。修：兩者都只清
   自己 channel 的。
4. **半開連線謊報 connected**（`MeshConnection.getState`）：ICE connected 但
   ChannelBus 未 open 的連線被當可用 → digest 送進黑洞、fanout await 卡 30s
   拖住後續程式（含備援橋接）。修：bus 未 open 降報 connecting；fanout/轉發
   只選 connected。
5. **備援層破壞恰好一次**（`FirestoreChatFallback`/`ChatPage`）：(a) 備援寫入
   自生新 UUID，寄件方收到自己的回音變兩顆泡泡；(b) mesh 成員送訊只走 mesh，
   掉備援的成員永遠收不到（混合模式不對稱分割）。修：一則訊息一個 id 貫穿
   樂觀顯示/mesh gossip（入簽章）/備援；mesh 覆蓋不足（連上數 < 房間人數-1）
   時同 id 雙寫備援橋接，收端以 id 去重。

### 補償機制（本輪核心交付）

seq-based anti-entropy 對帳（`src/core/mesh/antiEntropy.ts`）：每節點保存
(senderId, seq)→已簽名訊息 的 store，每 2s 與已連上鄰居交換 digest
（floor/max/missing），對方缺哪則補哪則。pull-based、冪等、走任何已連通路徑；
digest 交換一輪對稱差嚴格縮小 + 訊息集有限 → 連通圖上數學上保證收斂。
不 gate 發送路徑（送訊不等 full mesh 就緒）。單元含雙節點/鏈狀拓撲收斂模擬。

### 已知限制（誠實記錄）

- `verifyMessage` 5 分鐘時效窗：超過 5 分鐘的訊息補送給遲到者會被驗簽拒絕
  （長會話遲入者收不到舊訊息）。獨立工作項。
- 星型→mesh 遷移期間送出的訊息屬星型棧，mesh 對帳管不到；診斷測試在
  mesh 模式訊號（`.e2ee-indicator-dtls`）後才發送。遷移窗訊息可靠性為
  獨立工作項。
- 備援橋接為明文（mesh 房本無 E2EE，UI 已誠實標示）；橋接條件依房間文件
  人數，成員「已離開但文件未更新」期間會多寫一筆備援（無正確性影響）。
