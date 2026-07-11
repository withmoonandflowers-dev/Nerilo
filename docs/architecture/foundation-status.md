# 底層完善狀態 · 追蹤地圖

- 更新：2026-07-05
- 用途：一頁看清底層的冗餘/缺口「誰在管、到哪了」，供跨 session 協調。**不含實作細節**
  （細節見對應 ADR）。原則：同一關注只由一條線清，避免並行重工。

## 冗餘 · 現況與歸屬

| 項目 | 判定 | 負責 | 狀態 |
|---|---|---|---|
| **兩套傳訊棧**：star（P2PChannelBus + HLC/因果排序） ‧‧ mesh（gossip + antiEntropy seq） | 概念冗餘 | 平行 · ADR-0023 修訂五 | 🟡 **收斂中**：移除 star 分支、`Topology` 收斂為 `'mesh'` |
| **RelayOverlay / RelayCoordinator** | 死島（0 app 引用），被 FirestoreRelayDirectory 新路徑取代 | — | ✅ **已刪除**（2026-07-05；含 3 個 spec，git 歷史保留） |
| **三套 append-only log 概念**：ledger/SharedLedgerEngine（凍結）· incentive/CreditLedger · 房間複製日誌 | 概念重疊 | 平行 · ADR-0023 | 🟡 統一方向＝複製日誌 |
| `RelayDirectory`（IRelayDirectory 介面 + 記憶體實作） | **非冗餘** | — | 🟢 被 `FirestoreRelayDirectory` 採用（hexagonal） |
| ledger/SharedLedgerEngine · ForkResolver | 凍結（ADR-0007 第 2 類） | — | ⚪ 凍結，不動 |
| relay/ Sphinx · Kademlia · StoreAndForward | dormant | 平行 · P4 評估 | ⚪ 休眠 |

## 缺口 · 誰覆蓋

| 缺口 | 覆蓋者 | 狀態 |
|---|---|---|
| mesh 3–5 人可靠性 | antiEntropy（數學收斂）+ 測試工具鏈 | 🟢 邏輯完成，真實環境待驗 |
| star→mesh 切換 bug（切換重載重複/遺失） | ADR-0023 修訂五（直接移除 star 分支） | 🟡 隨收斂消滅 |
| 跨房：非成員找到要幫誰、怎麼連 | P4-A 名冊 ✅ / P4-B signaling | 🟡 A 完成、B 進行 |
| 盲信使寄存協議（存密文、對帳回補） | P4-C · ADR-0024 · RecordCrypto | 🟡 加密就位、協議待建 |
| 中繼計量（共簽收據→點數） | P4-D · CoSignedReceipt · ADR-0022 | 🔴 待接線 |
| 防女巫（點數正當性） | App Check（程式就位，待 console 啟用） | 🟡 待啟用 |

## 我這幾條 session 的底層貢獻 · 去留

| 貢獻 | 去留 |
|---|---|
| `IRelayDirectory` 介面 + 記憶體實作 | 🟢 **被採用**（FirestoreRelayDirectory 實作它） |
| `CreditLedger`（雜湊鏈可驗證帳本） | 🟢 已接（CreditEconomy 用） |
| `CoSignedReceipt`（共簽正當性） | 🟡 **P4-D 要用**（非死碼，slated） |
| `ConnectionStats`（直連/fallback 量測） | 🟢 已接 |
| extractable 修復 + 真 crypto 契約測試 | 🟢 已合入，回歸鎖住 |
| 聊天去重修復 + E2E 回歸 | 🟢 已合入 |
| 測試工具鏈（mutation/simulation/property/真crypto） | 🟢 已合入（antiEntropy 88% · RecordCrypto 81%） |
| `RelayOverlay` / `RelayCoordinator` | ✅ **已刪除**（被 P4 的 FirestoreRelayDirectory 取代） |
| GossipMessageHandler 的 anti-entropy hack | 🔴 **已被** antiEntropy.ts **取代**（乾淨版） |
| game 二進位 codec（ADR-0018）· 房主心跳 · 社群 TURN · 架構/C4 文件 | 🟢 已合入 |

## 協調原則

1. **底層冗餘清理歸平行 session（P4 + ADR-0023）**——單一負責，勿並行重工。
2. 我的角色：**測試工具鏈 + 誠實稽核 + 文件**（非破壞性、可與 P4 並存）。
3. 要動 relay/mesh/topology 核心前，先看本表與 ADR-0023 進度，避免撞 P4-B/C/D。
