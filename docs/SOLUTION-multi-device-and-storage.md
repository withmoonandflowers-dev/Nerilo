# 解決方案：多裝置同步與儲存節點

> 對應提問（2026-07-03）：同帳號多裝置能否同步、儲存節點誘因。
> 方向決策見 [adr/0014](adr/0014-multi-device-identity.md)（多裝置）、
> [adr/0011](adr/0011-relay-credit-economy.md)（儲存計價）、
> [adr/0012](adr/0012-community-relay-infrastructure.md)（社群節點）。
> 本文把方向落成可執行的分階段藍圖，並標出相對路線圖的位置。

## 核心洞察：兩個問題是同一套基建

多裝置同步 = 「把訊息送給我自己的另一台裝置」，本質就是離線投遞
（裝置 B 現在不在線）。所以它跟儲存節點是同一件事：
**需要一個 content-blind 的暫存層，讓 A 加密後存、B 上線後取。**
先建這層，多裝置與離線投遞一起解決。

## Part A：多裝置同步（分階段）

現況（ADR-0014）：身分綁裝置不綁帳號，完全不同步。四階段推進，
每階段獨立可上線、可誠實對外。

### P0 裝置身分持久化 + 帳號裝置註冊表（現在就能做，低風險）

問題：ECDH 身分金鑰每次 session 重生成（SenderKeyManager.ts:86），
重整就換身分。多裝置的地基是「穩定的裝置身分」。

做法：
1. ECDH 身分金鑰改持久化到 IndexedDB，複用 IdentityManager 現成範式
   （存 PKCS8，同一套 openDB/get/put）。sender key 維持每 session 更換
   （forward secrecy 不變），只有長期 ECDH 身分金鑰持久化。
2. 新增 Firestore 子集合 `/users/{uid}/devices/{deviceId}`，記錄
   { ecdhPublicKey, label, lastSeenAt }。裝置上線時 upsert 自己。
3. rules：`/users/{uid}/devices/{deviceId}` 只有 `isOwner(uid)` 可讀寫。
   公鑰是公開資訊，但限本帳號讀避免裝置圖譜外洩。

獨立價值：即使不做後續階段，P0 也修掉「重整換 E2EE 身分」的體驗問題，
並讓 dashboard 能顯示「你的裝置」。風險低（新增子集合，不動既有路徑）。

### P1 群組金鑰對「帳號所有裝置」分發（依賴 P0）

sender key 分發時，收件人從「單一 uid」推廣為「該 uid 的所有已註冊裝置」，
每台裝置各封裝一份 ECDH。SenderKeyManager.distributeSenderKey 已是
per-member 迴圈，改成 per-device 迴圈即可。這讓同帳號的每台裝置都能
解出房間 sender key。

### P2 跨裝置訊息同步（依賴 P1 + Part B 暫存層）

裝置 A 送訊息時，額外把密文副本存一份到暫存層（Part B），
收件人是「自己帳號的其他裝置」。裝置 B 上線拉取、解密、寫入本機
IndexedDB。訊息歷史因此在裝置間收斂（goal GC5）。全程 E2EE，
暫存層看不到明文。

### P3 裝置生命週期（安全收尾）

- 新增裝置需既有裝置授權（掃 QR 或帳號驗證），防帳號被盜後任意加裝置竊聽。
- 撤銷裝置（遺失）→ 從註冊表移除 + 強制 sender key 輪換（forceRotation 已存在）。

## Part B：儲存節點（daemon 藍圖）

對應 ADR-0012 第 2 層、ADR-0011 儲存計價。這是 Part A 的 P2 依賴的暫存層，
也是離線投遞的載體。

### 過渡實作（免 daemon，現在就有）

Firestore inbox 子集合（StoreAndForward 已寫好、rules 已備、TTL 可設）
先當暫存層。缺點是成本落在營運者、容量有限——所以只作為 daemon 出現前的
bootstrap，不是終態。

### 終態實作（社群 daemon）

headless Node 程式，任何人可跑（樹莓派 / VPS / EC2，ADR-0013 平台中立）：
1. 以受限身分連 Firebase 信令，宣告自己是儲存節點、加入 DHT。
2. 提供 store-and-forward：收密文、按 KB·小時計費、投遞後領獎金
   （ADR-0011 5b：存入簽收 + 取出投遞簽收兩段收據）。
3. 多副本：發送方冗餘策略決定存幾個節點，各自獨立計價。
4. content-blind：只見密文與路由 metadata，看不到明文也不掌握身分真相。

誘因閉環：跑節點賺點數 → 點數折抵訂閱費（ADR-0011）→ 用戶均攤付費
（受益者均攤）→ 節點營運者有報酬 → 社群容量隨用量擴張 →
營運者 Firestore 成本從線性降為保底。

## 相對路線圖的位置

| 項目 | 里程碑 | 現在能做？ |
|---|---|---|
| Part A P0（裝置註冊表 + 金鑰持久化） | 可提前，獨立價值 | 是，低風險 |
| Part B 過渡（Firestore inbox 暫存） | M2/M3 | 是（StoreAndForward 已備） |
| Part A P1（多裝置金鑰分發） | M4（身分統一） | 依賴 P0 |
| Part A P2（跨裝置同步） | M4 後 | 依賴 P1 + Part B |
| Part B 終態（社群 daemon） | M5 | 依賴點數帳本 M4 |
| Part A P3（裝置生命週期） | M4 後 | 依賴 P1 |

**建議排序**：Part A P0 是唯一「低風險、有獨立價值、可提前」的一步，
但它偏離當前 M2/M3 主線。是否提前投資多裝置地基，是排序決策，
不是技術決策——留給產品負責人拍板。主線（M2 收尾 → M3 付費驗證）
不受影響，因為付費驗證（有沒有人願意付錢）比多裝置（願付錢者的體驗升級）
更早需要答案。
