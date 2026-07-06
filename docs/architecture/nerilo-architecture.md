# Nerilo 系統架構（C4 / DDD / 生命週期）

- 日期：2026-07-06；狀態：現況基準（standing doc，隨 ADR 演進更新）
- 對應決策：ADR-0023（房間即複寫日誌，P1 已落地）、ADR-0024（盲信使儲存）
- 讀法：標 ✅ = 已實作並有測試；標 🎯Pn = ADR-0023 階段目標

## 1. C4 Level 1 — Context

```
┌──────────┐   訊息/遊戲/檔案（P2P，E2EE）   ┌──────────┐
│ 使用者 A  │◀══════════════════════════▶│ 使用者 B  │
└────┬─────┘                              └────┬─────┘
     │  auth / 信令 / metadata / 密文備援        │
     ▼                                        ▼
   ┌────────────────────────────────────────────┐
   │ Firebase（Auth + Firestore）                │
   │ 原則：伺服器永遠看不到明文內容               │
   └────────────────────────────────────────────┘
     ▲
     │ 🎯P4 盲信使：開著首頁的第三人 C 為他人房間
     │ 保存密文複本、參與補齊（讀不到內容）
┌────┴─────┐
│ 使用者 C  │（非成員節點）
└──────────┘
```

**系統定位**：P2P 資料傳遞平台（聊天與遊戲是內建參考應用，ADR-0009/0015）。
伺服器只做三件事：身分、連線撮合（signaling）、metadata 與密文備援。

## 2. C4 Level 2 — Containers

| Container | 技術 | 職責 | 狀態 |
|---|---|---|---|
| web-vue | Nuxt 4 SPA（neo 主題） | 產品 UI（聊天/遊戲/好友/房間管理） | ✅ 切換前 React 仍為線上版 |
| React app | React 18 + Vite | 線上版（凍結新功能） | ✅ nerilo.web.app |
| @legacy core | 框架無關 TS（src/core…） | 傳輸/複本/加密/激勵引擎，雙前端共用 | ✅ |
| Firestore | p2pRooms{signals,messages,memberStates}, friendships | metadata、信令、密文備援、已讀/釘選 | ✅ |
| IndexedDB（每使用者本地） | NeriloDB + NeriloReplica | 聊天史、身分金鑰、**複寫日誌複本**（P1） | ✅ |
| relayDirectory | Firestore（設計中） | 全站在線節點名冊（盲信使發現） | 🎯P4 |

## 3. C4 Level 3 — Components（core 內部，資料路徑）

```
UI（chat 頁 / dashboard）
 │
 ├─ MeshChatService ──── MeshGossipManager ─┬─ GossipMessageHandler ✅
 │   （3-5人，2人房 🎯P3 併入）              │    ├─ antiEntropy（digest/補齊，內容無關）✅
 │                                          │    ├─ GossipPersistence port ✅
 │                                          │    │    └─ GossipReplicaStore（Dexie）✅
 │                                          │    └─ SecurityManager（簽章；密文 🎯P2）
 │                                          ├─ MeshTopologyManager（發現/連線/心跳）✅
 │                                          └─ MeshConnection（bus 換代重掛 ✅）
 ├─ StarTopology（2人+E2EE）✅ ──→ 🎯P3 退役，統一走 gossip 管線
 ├─ GameTransportSDK（ns:'game' 騎同管線）✅
 └─ FirestoreChatFallback（密文/明文備援 + 橋接）✅ ──→ 🎯P4 由盲信使逐步取代
休眠資產：relay/*（Sphinx、Kademlia、PeerScoring）、transport/StoreAndForward、chain/（hash 鏈審計）
```

## 4. DDD — Bounded Contexts 與 Aggregates

| Bounded Context | Aggregate（root） | 不變量（invariants） |
|---|---|---|
| **房間與成員** | `Room`（roomId） | 離開畫面 ≠ 退出；全員軟刪除才真刪；participants 只能自增自減（rules 強制） |
| **訊息複本**（核心） | `ReplicatedLog`（roomId） | 紀錄身分 = (senderId, seq)；**seq 永不重用**（reserve-then-send）；恰好一次呈現 = 至少一次複寫 + id 去重；對帳只比對 id、不讀內容 |
| **身分與金鑰** | `Identity`（mesh keypair, IndexedDB） | senderId = hash(pubKey)；簽章涵蓋內容+seq+messageId+channel |
| **連線撮合** | `ConnectionSession`（sessionStartedAt） | 連線是**傳輸機會**不是狀態擁有者；死了只影響「何時補」，不影響「有沒有」 |
| **激勵** | `CreditLedger`（uid） | 只計真實事件（誠實條款）；共簽收據防自報刷點 |
| **盲信使** 🎯P4 | `CourierLease`（roomId×courierUid） | 信使=快取非權威；只存密文；墓碑即刪 |

**核心 domain events**：`RecordAppended`（本地寫入複本）→ `ReplicaReconciled`（對帳補齊）→ `RecordEvicted`（floor 推進）；`MemberRejoined`（重進，觸發 hydrate+對帳）；🎯P4 `LeaseGranted/Tombstoned`。

**架構級洞察（ADR-0023 的本體）**：`ReplicatedLog` 才是第一級公民；`ConnectionSession` 從「擁有資料的東西」降級為「搬運資料的機會」。這一升一降解掉了整類重連 bug。

## 5. 生命週期

### 5.1 Room
```
waiting ──第2人join──▶ open ──成員軟刪(×每人)──▶ 全員皆刪 ──▶ 真刪(墓碑 🎯P4 通知信使)
   │                    │ 離開畫面：狀態不變（持久房間）
   └─房主關──▶ closed   │ exitRoom：移出 participants
```

### 5.2 Record（一則訊息的一生）✅P1
```
reserveSeq(原子,IndexedDB) ─▶ 簽章 ─▶ 本地 append(複本落地) ─▶ fanout 直送
        ─▶ 各節點對帳補齊(digest/fill) ─▶ …年久 floor 淘汰(每sender cap 500)
不變量：任何時點 crash，seq 不重用（最壞留空洞，對帳容忍）
```

### 5.3 ConnectionSession
```
connecting ─▶ connected ─▶ disconnected（對方離開/網路斷）
                │                └─ 對方重進：底層自動重新協商 ─▶ bus 換代重掛 ✅
                └─ close()（自己離開）
重進後資料一致性由複本+對帳保證，與連線恢復速度解耦 ✅
```

### 5.4 CourierLease 🎯P4（設計，ADR-0024）
```
成員選中在線信使 ─▶ 寄存密文紀錄集 ─▶ 信使持有(TTL 14天/預算 LRU)
   ─▶ 成員回線向信使對帳拉回 ─▶ 服務量共簽收據→點數
   ─▶ 墓碑(簽章)/TTL/LRU/手動 四層刪除
```

## 6. 品質保證地圖（驗證錨點）

| 保證 | 測試 |
|---|---|
| 3人矩陣全=1（恰好一次） | tests/e2e(-vue)/mesh-diagnostic（React 版曾連續兩批 5/5） |
| 成員重進續傳、seq 不碰撞 | e2e-vue/mesh-rejoin（3綠） |
| 全員斷線後重生（local-first） | e2e-vue/all-offline-revival（3綠） |
| 跨 instance 複本/seq | unit/GossipReplica |
| 2人房重進 | e2e-vue/rejoin（fixme，🎯P3 轉綠 = star 退役驗收） |
