# Spec 014：補一個輕量的「可加入房間目錄」契約

- 軌別：feature
- 狀態：implementing（2026-08-24 T1-T6 完成；餘 T7 block-brawl 大廳換裝＝V1）
- 建立：2026-07-25／最後更新：2026-07-25
- 關聯：ADR-0025（可嵌入 SDK）、ADR-0027（room directory gossip）、`src/ports/IRoomDirectory.ts`、
  `src/services/RoomService.ts:901`（`getPublicRooms`）、block-brawl `docs/nerilo-integration.md`（缺口 1）

> **2026-07-26 更新：本 spec 的必要性已由實測證實，不再是「沒有被擋住的使用者」。**
> Spec 015 的 T6 查出：第三方要用 signaling 出口，得先有 Nerilo 房間、且房主須為
> 非匿名帳號（`firestore.rules:144`、`:198-204`）。純匿名情境（遊戲大廳）因此完全
> 過不去。本 spec 補的正是那個缺口，它是 015 對外可用的**前置條件**，
> 而非原本評估的「有了更好」。
>
> 注意：真正的阻礙不只是「缺一個目錄契約」，還包含「匿名能不能建房」這個**安全模型
> 決策**（CROSS-MACHINE-HANDOFF 已列為待使用者拍板、勿自動實作）。本 spec 進 plan
> 之前必須先解那一題。
>
> **2026-08-24 已拍板：維持非匿名建房，安全模型不動。** 遊戲情境的玩家要開目錄房
> 必須先登入（非匿名帳號）。後果誠實記錄：休閒遊戲大廳的「零登入開房」體驗做不到，
> 嵌入者要自行處理登入流程；匿名玩家仍可加入他人開的房（既有 rules 允許）。
> 本 spec 據此解除封鎖，rules 面零改動。同日使用者確立產品方向：Nerilo 除聊天外
> 也要是遊戲的傳輸基礎（關聯 Spec 023 原始通道、Spec 024 狀態 API）。

## 1. 要做什麼、為什麼（specify）

第一個外部嵌入者（block-brawl，2026-07-25）想用 Nerilo 做大廳「列出可加入的房間」，
結果只能自己刻，因為 SDK 沒有能用的契約：

- `IRoomDirectory` 名字很像，但語義是**單一房間內的成員名冊**（meshIdentities／participants），
  跟「有哪些房間可以加入」是兩件事。
- 唯一能列房間的面是 `IRoomService`，14 個方法、綁 `P2PRoom`（含 `status`、`waitingTimeout`、
  `meshIdentities`、`maxParticipants` 等聊天 app 專屬欄位），而且**沒有出現在 SDK 公開表面**上。
  要第三方為了列一份房單去實作 `createRoom`／`activateRoom`／`updateMeshIdentity`，不合理。
- 結果：`getPublicRooms` 這個 Nerilo 已經寫好、跑在 production 的能力，第三方拿不到。

要一個小的、意圖層級的目錄契約：**列出可加入的房間、公告我開了一間、收掉**。
外加一個 InMemory 參考實作與一個 Firestore 預設實作，讓嵌入者能零後端起步、也能一行換成 Firestore。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**可嵌入**（補上嵌入者實際撞到的缺口，有真實案例背書，不是臆測需求）。
- 四條不變量影響：恰好一次〈無影響：不碰訊息路徑〉；E2EE〈無影響：房間中繼資料本來就明文，
  威脅模型 R6 已載明，本 spec 不擴大也不縮小該面〉；帳本正當性〈無影響〉；
  **身分與授權**〈有影響：誰可以列到哪些房、誰可以公告，必須由 rules 端強制，不能只靠 client 端契約〉。

## 2. 邊界（明確不做）

- 不做房間的建立／加入／關閉的完整生命週期（那是 `IRoomService` 的事，不搬進新契約）。
- 不動 `IRoomDirectory` 的既有語義與既有呼叫端（mesh 成員發現照舊）。
- 不改 `P2PRoom` 型別、不改 firestore.rules 的既有授權模型。
- 不做跨伺服器的房間聯邦／全域搜尋。
- 不為 block-brawl 的大廳量身訂做欄位（該遊戲的 mode／count 等屬應用層自訂，走自由欄位）。

## 3. 待釐清（clarify，2026-07-25 使用者拍板，決議內嵌於各題）

- [x] **Q1 契約範圍**：拍板 **列出 + 公告自己的房**，即 `list`／`watch`／`publish`／`unpublish`
      四個動作。這是大廳真正需要的最小集合，仍遠小於 `IRoomService` 的 14 個方法。
- [x] **Q2 房間型別**：拍板（技術判斷，非需求歧義，故由提案者決定並記錄）新定義瘦型別
      `CatalogRoom`。沿用 `P2PRoom` 會把 `status`／`waitingTimeout`／`meshIdentities`／
      `maxParticipants` 等聊天 app 專屬欄位塞給所有嵌入者，正是本 spec 要解決的問題本身。
- [x] **Q3 預設實作**：InMemory 參考實作 + Firestore 版**一起公開**。理由：Q4 已決定與
      Spec 015 同批出，而 015 就在公開 Firestore signaling；只給 InMemory 會讓 014 沒有
      任何真實可用情境，重蹈「有契約沒後端」的覆轍。
- [x] **Q4 與 Spec 015 的關係**：拍板 **同一批出**，公開表面一次改完，只發生一次 minor 破壞。

〔誠實記錄〕提案者原建議「先做 015、014 等跨機器對戰成立後再用真實情境倒推」，
理由是 014 目前沒有實際被擋住的使用者（block-brawl 同機大廳用 BroadcastChannel 就夠）。
使用者拍板兩個同批做。風險承接於此：014 的動作集合是依大廳常識設計，
不是被真實需求逼出來的，第一個嵌入者上線後可能要調整，這正是 SDK 維持 0.x
（見 SDK-QUICKSTART 版本承諾）的用途。

## 4. 技術計畫（plan）

〔實作期修訂 2026-08-24，三處〕
① `publish` 簽名改 `publish(room: Omit<CatalogRoom,'id'> & {id?}): Promise<string>`——
Firestore 的房間 id 由後端生成（createRoom 內部 UUID），caller 給定 id 做不到；
契約以回傳值為權威 id，InMemory 版沿用給定值或自生。原 `Promise<void>` 版本無法誠實實作。
② `getPublicRooms` 補映射 `roomName`／`maxParticipants`（欄位一直在 Firestore 文件裡，
映射層漏抄，整合測試抓到）。
③ `watch` 明定為輪詢實作（預設 15s 可調）：2026-07-13 配額事件後公開列表刻意不掛
常駐 onSnapshot，SDK 不繞開該決策。
④ `publish` 內部＝createRoom→activateRoom 兩步：waiting 房不進公開列表（status 過濾），
公告語義要求直接啟用。

### 4.1 契約

```
CatalogRoom { id, name?, occupancy?, capacity?, meta? }   // meta＝應用層自由欄位
IRoomCatalog {
  list(): Promise<CatalogRoom[]>
  watch(onChange: (rooms: CatalogRoom[]) => void): () => void
  publish(room: CatalogRoom): Promise<void>
  unpublish(id: string): Promise<void>
}
```

`meta` 是刻意的逃生口：block-brawl 需要 `mode`（pvp／coop）與房主暱稱，聊天需要別的。
把應用層欄位收進一格自由欄位，契約才不會每來一個嵌入者就長大一次。

`watch` 的語義對齊既有 `IRoomDirectory.watchIdentities`：訂閱當下先收一次目前狀態，
之後每次變更各一次。同一份心智模型，嵌入者不必學兩套。

### 4.2 實作與命名

- `InMemoryRoomCatalog`（+ Hub，比照 `InMemoryRoomDirectoryHub` 的形狀），零後端起步。
- `createFirestoreRoomCatalog()` 於 `nerilo/firestore`：`list` 包既有
  `RoomService.getPublicRooms`（`src/services/RoomService.ts:901`，已含
  status/isPrivate/TTL 過濾與 limit 20），`publish`／`unpublish` 對應建房與關房的
  最小子集。工廠函式而非類別，理由同 Spec 015 Q2。
- **命名風險**：`IRoomDirectory`（房內成員名冊）與 `IRoomCatalog`（房間列表）容易混淆，
  這正是本 spec 起因的那個誤會。兩者的 doc comment 要互相指名對方並說明差異。

### 4.3 授權

Firestore 版不新增授權面：沿用 `getPublicRooms` 既有的
`status=='open' && isPrivate==false && ttlExpireAt>now` 伺服器端過濾。
`publish`／`unpublish` 沿用既有建房／關房的 rules（含 Spec 011 的 `maxParticipants`
容量驗證），不為 catalog 另開寫入路徑。

## 5. 任務分解（tasks）

- [x] T1：定義 `CatalogRoom` 與 `IRoomCatalog`（`src/ports/`），doc comment 與
      `IRoomDirectory` 互相指名以防再次混淆。
- [x] T2：`InMemoryRoomCatalog` + Hub 參考實作。
- [x] T3：`createFirestoreRoomCatalog()` 於 `nerilo/firestore`（⚠ 動運作中路徑：
      包裝既有 `getPublicRooms`／建房／關房，先走 harden-tests）。
- [x] T4：契約測試雙跑：InMemory 單元 4 例＋Firestore emulator 整合 2 例（真實 rules）。
- [x] T5：fitness 表面快照納入 4+1 新匯出；prune-sdk-types、pack 冒煙（主入口 16 執行期匯出）全綠。
- [x] T6：SDK-QUICKSTART 增「房間目錄」一節，明寫與 `IRoomDirectory` 的差別與四條誠實邊界。
- [ ] T7：block-brawl 大廳改用本契約（V1）。

## 6. 驗收（黃金判準）

- [ ] V1 外部嵌入者實證：block-brawl 的大廳目錄改為本契約實作，**遊戲邏輯零改動**
      （只換工廠），沿用 Spec 013 的驗收精神，用真的消費者證明縫是真的。
- [x] V2 契約可替換：同一組契約測試同時套用 InMemory 與 Firestore 版，行為一致
      （比照 block-brawl `test/nerilo-signaling.test.js` 的雙跑法）。
- [x] V3 公開表面受控：`sdkSurface` 顯性納入新匯出；`prune-sdk-types --max=30` 不爆。
- [x] V4 授權不是口頭的：rules 整合測試證明「私人房與已關閉房不會出現在任何人的 `list`」。
- [x] V5 既有路徑零回歸：T3 包裝後，既有公開房列表行為（React／Vue 兩線）不變。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做：需求＝嵌入者能列房與公告房；
      方案＝瘦型別 + 四動作 + 兩實作。生命週期其餘部分（join／activate／meshIdentity）
      依第 2 節排除，未擴張。
- [x] 第 5 節任務完整實現第 4 節，無遺漏：T1 對應 4.1 契約、T2/T3 對應 4.2 兩實作、
      T4/T5 是閘門、T6 對應 4.2 的命名混淆風險、T7 是 V1 的執行面。
- [x] 第 6 節驗收能證明第 1 節：V1 用真實嵌入者證明「能用且不必改遊戲邏輯」；
      V4 把授權從口頭承諾變成 rules 測試，本 spec 唯一碰到不變量（身分授權）的地方。
- [x] 未違反憲法任何一條：第 3 條（新功能先問加分哪個係數）已於第 1 節回答為「可嵌入」，
      且第 3 節誠實記錄了「本 spec 尚無被擋住的真實使用者」這個弱點，未灌水。
