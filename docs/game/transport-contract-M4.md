# M4 傳輸契約：遊戲資料流騎在 mesh 可靠廣播上

- 狀態：Implemented（2026-07-05）
- 承接：ADR-0015（遊戲為第二參考應用）、ADR-G01、mesh 可靠性第三輪
  （docs/QA-REPORT-chat.md 第三輪：anti-entropy 對帳 + 五根因修復）

## 結論一句話

遊戲事件通道成為 gossip 可靠廣播管線的**第二個 consumer**（第一個是聊天）：
不另建協議，`GossipMessage` 加簽章保護的 `channel` 欄位分流，遊戲事件在
3–5 人 mesh 上獲得與聊天同等的「最終各恰好一次」保證。

## 送達模式矩陣

| 模式 | 保證 | 載體 | 適用 | 狀態 |
|---|---|---|---|---|
| reliable-exactly-once | 最終各恰好一次、簽章、去重、anti-entropy 補送 | gossip `channel:'game'` | 回合制/lockstep 事件（出招、入座、seed commit-reveal、state hash） | ✅ 本次實作 |
| star-broadcast | ordered+reliable（單一 DataChannel） | `P2PBusBroadcast`（ns:'game'） | 2 人星型 | ✅ 既有（ADR-0015） |
| realtime-lossy | 無序、可丟、無重送、二進位幀 | `StateChannel`（ordered:false, maxRetransmits:0）+ ADR-0019 codec | 60Hz 位置/狀態流 | ✅ 星型已接（Beta，`p2pManager.getStateChannel()`）；mesh 未接 |

## 接線（mesh, 3–5 人）

```
GameTransportSDK ── setBroadcaster ──> MeshGossipBroadcast
      ▲                                      │ sendMessage(JSON(envelope), envelope.id, 'game')
      │ handleEnvelope（runtime 驗證）        ▼
GameFeature <── channel:'game' 過濾 ── MeshGossipManager.onMessage
                                      （簽章+去重+anti-entropy 的 gossip 管線）
```

入口：`attachGameTransportToMesh(meshGossipManager, sdk, selfId, roomId)`
（`src/core/game/sdk/MeshGossipBroadcast.ts`）。星型房沿用
`attachGameTransport(bus, …)` 不變。

## 契約細則

- **通道分流**：`channel` 缺省視同 `'chat'`；`'game'` 的 content 是遊戲
  envelope JSON。channel 在簽章覆蓋範圍內——竄改通道＝驗簽失敗
  （防把聊天內容推進遊戲分發、或反向）。聊天端（MeshChatService）與
  遊戲端（attachGameTransportToMesh）各自過濾非己通道。
- **定向 send**：廣播 + `to` 欄位、收端過濾（與星型版同語義）。3–5 人
  下廣播成本可接受；真正 peer 定向路由屬後續優化，不在本契約。
- **去重身分**：傳輸層 (senderId, seq)；應用層 envelope.id 貫穿為
  gossip `messageId`（簽章保護），未來遊戲若加備援橋接可跨路徑去重。
- **速率**：與聊天共用 10 msg/s/sender 的 rate limit。回合制/lockstep
  事件（≤每 tick 一則輸入聚合）足夠；這也是「realtime 請走 lossy 通道」
  的硬邊界。
- **store 語義**：每 sender 保留最近 500 則（超過淘汰最舊、floor 前不回補）。
  遲入/斷線重連的**遊戲狀態**追趕走 GameSession 快照（SNAPSHOT_*），
  不依賴傳輸層重放全部輸入史——store 只保證「在房成員」的事件恰好一次。
- **拓撲涵蓋**：2 人星型（既有）、3–5 人 mesh（本次）。6+ 人 partial mesh
  未接線（與聊天一致）。
- **信任邊界**（ADR-G01 不變）：簽章擋第三者偽造與跨通道竄改；
  不能防對端改自己 client（競技作弊）。state-hash 抽驗擋 casual desync。

## 驗證

- `tests/unit/MeshGossipBroadcast.spec.ts`：outbound 形狀（channel/messageId/
  envelope JSON）、inbound 進 input buffer、通道分流、定向過濾、壞 JSON 免疫。
- `tests/unit/SecurityManager.spec.ts`：channel 竄改驗簽失敗 + round-trip。
- `tests/unit/MeshChatService.spec.ts`：game 通道不進聊天顯示。
- 可靠性本體（去重、對帳收斂、5/5 診斷矩陣）由聊天通道的既有測試鏈
  背書——同一條管線，通道欄位不改變傳輸行為。

## 遊戲事件「不做」Firestore 備援橋接（決策記錄，2026-07-05）

聊天有備援橋接（正確性優先）；遊戲事件**刻意不做**：
1. 回合制斷線的正確 UX 是「對局暫停」——雙方同時失去對方輸入，暫停是
   誠實狀態；經伺服器續打反而掩蓋連線降級。
2. 遊戲流量頻率高於聊天，橋接的 Firestore 讀寫成本與 P2P 敘事直接矛盾。
3. lockstep/state-hash 對延遲敏感，Firestore 往返會放大 desync 窗口。
實作：demo 面板在 `connectionState !== 'connected'` 顯示「連線中斷，
對局暫停」並鎖操作（`TicTacToePanel`）。

## 里程碑 1 已達（2026-07-05）

「連線 → 出招 → 對方看到」：井字棋 demo（`src/features/game/`，
ChatPage 🎮 進入，2 人星型房）。事件式（spec §2）ns:'ttt' 騎 bus，
含 SYNC_REQ/SYNC_STATE 開面板對齊（手數多者為準、收端驗形狀重算勝負）。
E2E：`tests/e2e/game-ttt.spec.ts` 雙向出招 + 回合輪替 + 晚開面板對齊，
3 輪連跑全綠。**這是遊戲第一次真的跑在 Nerilo 傳輸層上。**

## 未盡事項（誠實清單）

1. realtime-lossy 通道 mesh 版未接（星型已有 `StateChannel`）；
   等有即時遊戲消費者再接，避免無謂動剛穩定的 mesh 連線層。
2. 井字棋 demo 限 2 人星型房；mesh 房遊戲（3+ 人、走 gossip 可靠通道）
   是里程碑 2+ 的事。
3. seq 跨頁面重載會重置（與聊天同源的已知缺口），重載即視為離席重入，
   遊戲層以 SESSION_JOIN + 快照處理；demo 以 RESTART 收斂。
4. bus 驗證要求 payload 必須存在——無 payload 的 envelope 整包被丟
   （本輪踩到：SYNC_REQ 空 payload 被靜默丟棄；遊戲事件一律帶 `{}` 起跳）。
