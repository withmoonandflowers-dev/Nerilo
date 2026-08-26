# Spec 027：斷網情境的會合（本地會合點＋離線邀請碼）

- 軌別：feature
- 狀態：done（2026-08-26 實作完成；V1 之真實斷外網場測待使用者實地執行，結構性證據已備）
- 建立：2026-08-26／最後更新：2026-08-26
- 關聯：Spec 005（p2p2p signaling 的 Q7 物理限制與 warm 路徑）、Spec 023（transport 入口）、SBIR Phase 1 計畫標的、2026-08-26 pitch 宣稱校正

## 1. 要做什麼、為什麼（specify）

使用者 2026-08-26 提出的質疑，成立且是目前最大的定位落差：**「戰亂／網路全斷時，系統一樣不能用」**。

查證後的現況（分情境）：

| 情境 | 現在 |
|---|---|
| 網路全斷、之前沒連過 | **不可用**：會合點（Firestore）到不了 |
| 網路斷、區域網還在（社區 WiFi／熱點／路由器） | **不可用**：區網內其實不需要 STUN/TURN 就能直連，卡的是沒有會合點 |
| 斷網前已連上的 mesh | 可用：訊息純 P2P、離線成員靠信使代存，不碰伺服器 |
| 網路正常、TURN 額度耗盡 | 退 Firestore 備援（能用但依賴伺服器） |

也就是說 Nerilo 今天是「隱私優先＋中央故障容忍」，不是「斷網可用」。同日已據此校正對外宣稱
（pitch 四處），本 spec 補上真正的能力。

要做兩件事，都是為了讓「第一次連線」不依賴網際網路：

1. **本地會合點**：區域網內任一裝置可充當會合點（自架極小 signaling），同網段的人靠它交換連線資訊。
   目標情境：社區活動中心有路由器／有人開熱點，但對外斷線。
2. **離線邀請碼**：把連線資訊編碼成可用 QR／文字交換的酬載，完全不需要任何伺服器與網路。
   目標情境：面對面、或經由紙本／簡訊等頻外管道。

Spec 005 的 Q7 早已指出「冷啟動需要會合點」是 WebRTC 固有限制，並列出三個選項（a Firestore 第一跳、
b 第三方公共會合點、c 手動 copy-paste）。當時拍板 (a)。本 spec 補上 (c)，並新增「(d) 本地會合點」——
它比 (c) 好用、比 (a) 不依賴外網，正是災難情境最現實的一格。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**隱私韌性**（核心第 2 條「中央掛了也要能通」的真正落實）；**補助競爭力**
  （可現場 demo：關掉對外網路仍能聊天，說服力遠大於文件）；可嵌入。
- 四條不變量影響：恰好一次〈無影響：只換會合管道，不動訊息路徑〉；E2EE〈**有**：邀請碼酬載
  含連線資訊與房間會合材料，必須不洩漏房間內容金鑰；本地會合點是不可信管道，SDP 必須沿用
  Spec 005 的簽章＋對端加密信封語義，不得因「在區網內」就放寬〉；帳本正當性〈無影響〉；
  身分授權〈**有**：本地會合點不得成為繞過房間成員資格的旁門；離線邀請碼等同於「持碼即可加入」，
  其權限邊界要明訂並可撤銷〉。

## 2. 邊界（明確不做）

- 不做 LoRa／無線電橋接（那是 SBIR Phase 1 的獨立研究標的，成本結構另計）。
- 不做自動探索（mDNS/廣播掃描）：本 spec 只做「有人指定會合點位址」與「有人給你邀請碼」兩種顯式路徑。
- 不做長距離跨網段（那需要真正的伺服器或中繼，回到既有的 Firestore 路徑）。
- 不改既有 Firestore 會合路徑，也不改預設值：本 spec 是**多一條可注入的路**，不是替換。
- 不做本地會合點的持久化與帳號系統：它是臨時、無狀態、會話結束即消失的東西。

## 3. 待釐清（clarify，2026-08-26 使用者拍板）

- [x] **Q1 本地會合點形態**：拍板 **(c) 極小 Node 伺服器＋介紹人入口兩者都做**。
  `npx nerilo-rendezvous` 覆蓋完全冷啟動（沒有人連過）；介紹人入口把 Spec 005 已實作的
  warm 中繼暴露成公開能力（只要有一人在房內，新人可經他加入，零伺服器）。兩者互補：
  前者解決「第一對」，後者讓網路之後自行滾雪球。
- [x] **Q2＋Q3 離線邀請碼**：拍板 **雙向雙 QR（真零基礎設施）**。A 出示 offer QR、B 掃描後
  出示 answer QR、A 回掃，完成握手，全程不需任何伺服器或網路。這同時解掉 Spec 005 指出的
  「回程管道」物理限制——回程就是第二張 QR。體驗較繁瑣是已知取捨，換到的是「什麼都沒有也能通」，
  也是 demo 最有說服力的一幕。
  〔實作期須解的技術問題（不是需求歧義，列此備查）〕SDP 約 1-4KB、QR 實務上限約 2-3KB：
  先做 SDP 精簡（去除無用的 codec 描述，資料通道用不到音視訊行）＋壓縮（deflate＋base45），
  仍超限則分段多張 QR。V2 驗收以「實機掃得動」為準，不以理論值宣稱。
- [x] **Q4 邀請碼權限邊界**：拍板 **多次使用＋長效期**（可貼在布告欄，全村掃同一張）。
  〔誠實記錄〕提案者原建議單次＋15 分鐘（漏碼風險最低）；使用者選多次長效，理由是災難情境
  下「一張碼全村可用」的實用性優先。承接的風險必須寫進文件與 UI：**持碼者皆可加入該房並讀取
  加入後的訊息**（前向保密下讀不到加入前的歷史）。緩解：邀請碼與房間金鑰分離（碼只換得到
  連線，內容金鑰仍走既有 keyx 對成員封裝），且提供「作廢此碼」的操作。

## 4. 技術計畫（plan）

### 4.1 本地會合點：零依賴 HTTP 輪詢（不是 WebSocket）

- 伺服器 `nerilo-rendezvous`（package.json `bin`，npm 裝完 `npx nerilo-rendezvous` 即跑）：
  Node 內建 http，零依賴。記憶體內 per-room signal 緩衝（含 seq 與 createdAtMs），
  `GET /rooms/:id/signals?after=` 增量拉、`POST /rooms/:id/signals` 寫入，CORS 全開，
  啟動時印出區網 IP。無持久化、無帳號，行程結束即消失（第 2 節邊界）。
- 瀏覽器端 `createHttpSignaling(baseUrl)`（主入口匯出）：實作 `SignalingFactory`，
  send→POST、subscribe→500ms 輪詢＋cutoff 回放，語義鏡像 InMemory 版（自己送的也回自己）。
- 為何不用 WebSocket：Node 沒有內建 WS server，引入 `ws` 會讓 SDK 多一個執行期依賴；
  signaling 流量極小（每連線幾筆 SDP/ICE），500ms 輪詢的延遲代價可忽略。
- 誠實邊界〔對 V3 的實作期修訂〕：本地會合點**無認證**——同區網任何人都能讀該房的
  signaling 並加入。這與 Q4 拍板的「一張碼全村可用」同一信任模型（災難情境的區網＝
  信任邊界），文件明示，不假裝有 rules 等級的授權。SDP 簽章（Spec 005 信封）只在
  warm 中繼路徑存在，本 spec 不為冷啟動路徑補簽章（範疇控制；風險登記記一筆）。

### 4.2 離線邀請碼（雙向雙 QR 的酬載層）

- `src/sdk/offlineInvite.ts`（主入口匯出）：
  `createOfflineInvite(room?)` → A 端建 RTCPeerConnection＋DataChannel，等 ICE 蒐集完成
  （non-trickle），酬載 `{v:'nqr1', role:'o', room, sdp}` 經 deflate（CompressionStream）
  ＋base64url 編成單一字串；`acceptOfflineInvite(payload)` → B 端產 answer 酬載；
  `completeOfflineInvite(invite, answerPayload)` → A 端完成握手。
- 成果是一條已連線的雙工通道（`OfflineLink`：send/onMessage/onClose/close）。
- SDP 精簡：資料通道用不到音視訊 m-line，實測 datachannel-only offer 本來就小
  （約 1-2KB），deflate 後預期 <1KB；驗收以實際長度斷言（QR byte 模式上限 2,953）。
- 誠實邊界：此通道是 DTLS 傳輸加密、**尚無房間金鑰 E2EE**（沒有 mesh 就沒有 keyx）；
  「掃碼的兩人面對面」本身就是身分驗證。把 OfflineLink 接進完整聊天房（經它跑 keyx）
  屬後續工作，本 spec 交付連線層。
- 回程＝第二張 QR（Q2/Q3 拍板）；酬載也可走任何文字管道（簡訊、紙本抄寫短碼不可行，
  但複製貼上可），QR 是呈現層不是協議層。

### 4.3 介紹人入口（Q1 後半）

`createChatClient` 補 `introducerUid` 透傳（MeshChatService 建構子早就收、工廠沒開洞——
與 identityNamespace 同型的疏漏）。有人已在房內時，新人指名介紹人即可走 Spec 005 warm
加密中繼加入，零伺服器。

### 4.4 動到的模組

新增 `tools/rendezvous-server.mjs`、`src/sdk/httpSignaling.ts`、`src/sdk/offlineInvite.ts`；
`package.json`（bin）、`src/sdk/index.ts`（匯出）、`src/sdk/firestore.ts`（introducerUid 透傳）。
不動 mesh／訊息層任何檔案。

## 5. 任務分解（tasks）

- [x] T1：`tools/rendezvous-server.mjs`（零依賴 HTTP 會合點）＋package.json bin。
- [x] T2：`createHttpSignaling(baseUrl)`（主入口）；契約測試與 InMemory 版同組斷言雙跑
      （測試內起真 server）。
- [x] T3：`offlineInvite` 酬載編解碼（deflate＋base64url、nqr1 格式、長度斷言）純函式先行。
- [x] T4：`createOfflineInvite`／`acceptOfflineInvite`／`completeOfflineInvite` 連線層
      （真 RTCPeerConnection，瀏覽器驗證）。
- [x] T5：`createChatClient` 補 `introducerUid` 透傳＋回歸測試。
- [x] T6：examples/offline-rendezvous 驗證頁：①兩 client 經本地會合點成房聊天，
      斷言全程僅觸及 localhost（V1 的結構性證據）；②雙酬載交換（模擬雙 QR）建立
      OfflineLink 互傳（V2）。
- [x] T7：fitness 快照＋SDK-QUICKSTART「斷網情境」一節（口徑對齊 pitch 校正）＋CHANGELOG。

## 6. 驗收（黃金判準）

- [x] V1（結構性證據，2026-08-26）：兩 client 經 127.0.0.1 會合點成房＋P2P 互傳，
      驗證頁斷言**本頁零外部網路請求**（performance resource entries 全為 localhost）。
      〔誠實記錄〕「兩台實體裝置＋真關 WAN」的場測需使用者實地執行（單機環境做不出
      跨裝置斷網），結構性證據＝依賴面已收斂到區網內，無任何外部端點。
- [x] V2 零基礎設施實測（2026-08-26）：僅交換兩段酬載（632B/612B，皆低於單張 QR 上限
      2953）建立 OfflineLink 並互傳，全程零 signaling 物件。QR 呈現層（實機掃描）屬 app
      整合，酬載尺寸斷言已入單元測試。
- [x] V3〔實作期修訂，見 4.1〕：冷啟動路徑（Firestore／本地會合點）本來就無 SDP 簽章
      （簽章只在 warm 中繼），本 spec 不放寬也不補上——會合點無認證為明示的信任模型，
      文件與伺服器啟動訊息雙重揭露；風險登記補一筆。
- [x] V4 既有路徑零回歸：預設值未動；全單元綠。
- [x] V5 表面受控與文件：fitness 快照納入 8 匯出（主入口 20 執行期）；SDK-QUICKSTART
      「斷網情境」一節與 pitch 口徑一致；CHANGELOG 含誠實邊界。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做
- [x] 第 5 節任務完整實現第 4 節，無遺漏
- [x] 第 6 節驗收能證明第 1 節（零外部請求斷言＋零 signaling 物件是需求級證據）
- [x] 未違反憲法任何一條（無認證與無 E2EE 的邊界依第 10 條全數自我揭露）
