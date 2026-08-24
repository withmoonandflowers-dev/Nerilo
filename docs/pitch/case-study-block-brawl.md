# 採用案例：網頁格鬥遊戲 block-brawl 以 Nerilo 契約完成對戰連線

供補助與競賽評審、以及評估 Nerilo 的開發者參考。這份文件記錄第一個非聊天系統採用 Nerilo 的實例：一款瀏覽器格鬥遊戲，用 Nerilo 的 signaling 契約完成 WebRTC 對戰連線。所有宣稱都附程式碼與測試錨點，可自行查核。

## 背景

block-brawl 是一款 Phaser 3 網頁格鬥遊戲（獨立開發，未公開發行），連線對戰採 lockstep 同步：兩端各自模擬整個世界，只交換每格的輸入指令，並定期比對世界雜湊確認沒有走散。要建立這條 WebRTC 連線，需要 signaling：交換 SDP 與 ICE 資訊的管道。

## 它怎麼用 Nerilo

和典型的 SDK 用法方向相反。遊戲把 Nerilo 公開的 `SignalingTransport` 與 `SignalingFactory` 介面當作規格，自己寫了一個以 BroadcastChannel 為後端的實作（98 行），型別以 TypeScript checkJs 對 nerilo 0.9.0 的型別定義檔驗證；全程未執行 Nerilo 的執行期程式。Nerilo 在這個案例裡的角色是一份可由第三方自帶後端實作的連線契約，整包引入並非前提。

分工如下，只有 signaling 這一段走 Nerilo 契約：

| 環節 | 誰負責 |
|---|---|
| SDP 與 ICE 交換 | Nerilo `SignalingTransport` 契約，遊戲自製 BroadcastChannel 後端 |
| 房間列表與配對 | 遊戲自建（Nerilo 目前沒有輕量房間列表契約，見下方回饋） |
| 對戰輸入資料 | 遊戲自建的 RTCDataChannel（unordered、不重傳），每格約 100 至 150 bytes，不經 Nerilo |

## 驗證結果

1. 契約測試 18 例全數通過：同一套 8 條斷言分別對 Nerilo 內建的 InMemory 參考實作與遊戲的 BroadcastChannel 實作執行，兩者行為一致，另加 2 條跨分頁測試。指令 `npx vitest run test/nerilo-signaling.test.js` 可重跑。
2. 實機對戰驗證（2026-07-25，兩個瀏覽器分頁）：建房、加入、WebRTC 直連成功（transport 標記為 rtc，不是 4 秒逾時後的備援路徑，證明 signaling 真的通了）、開打後兩端在第 556 格的世界雜湊皆為 4116894088，console 零錯誤。當日該專案單元測試 61 例全綠。

## 這個案例證明什麼

1. Nerilo 的可注入介面經得起第三方實作檢驗：只憑公開型別與契約測試，無需閱讀 Nerilo 內部程式碼，就能寫出行為一致的自製後端，並用它完成真實的 WebRTC 連線。
2. Nerilo 的分層是乾淨的。遊戲的高頻輸入流量（每秒數十則小訊息）走自己的 DataChannel，不受 Nerilo 聊天層每人每秒 10 則的速率設計影響；signaling 與資料層各走各的。
3. 採用成本低。整合面只有一個介面、一個測試檔、約 90 行實作。

## 誠實邊界

1. 本案例為同機跨分頁連線：BroadcastChannel 只在同一瀏覽器同源分頁間互通，且未設定 STUN/TURN。跨機器對戰需換成跨網路的會合後端（Nerilo 預設的 Firestore signaling，或自架 WebSocket），契約不變，換後端即可。此項屬規劃中，尚未實作。
2. 配對與大廳未走 Nerilo，因為 SDK 目前沒有輕量的「列出可加入房間」契約。
3. 這是開發者自己的專案採用自己的 SDK（dogfood），說服力低於外部團隊採用；列於此是作為契約可實作性的證據，不冒充外部客戶。

## 回饋回 Nerilo 的具體缺口

dogfood 的價值在於暴露真實整合會踩到的洞。本案例回饋三項，均已記錄於整合筆記：

1. 缺輕量房間列表契約（現有 IRoomDirectory 是房內名冊，IRoomService 綁定完整房間模型，都太重）。
2. Firestore signaling 需要可獨立引用的公開出口。已開 Spec 015 處理，2026-07-26 以降級範圍收斂。
3. BroadcastChannel 類後端的 cleanup 只能清本地緩衝，契約的 best-effort 語意應在文件明示。此外提案了 `openRawChannel` API（讓採用方直接開低延遲原始通道），尚未排程。

## 查核錨點

- 契約實作：`block-brawl/src/net/neriloSignaling.js`（BroadcastChannel 後端）
- 消費端：`block-brawl/src/net/connection.js`（SDP/ICE 收發與連線建立）
- 契約測試：`block-brawl/test/nerilo-signaling.test.js`（18 例）
- 整合筆記與實測紀錄：`block-brawl/docs/nerilo-integration.md`
- Nerilo 端契約：`src/sdk/index.ts`（`SignalingTransport`、`SignalingFactory`、`InMemorySignalingHub`）
