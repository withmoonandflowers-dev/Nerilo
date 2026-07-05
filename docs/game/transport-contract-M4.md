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
| realtime-lossy | 無序、可丟、無重送 | 需 maxRetransmits=0 DataChannel + 二進位幀（ADR-0019 codec 已備） | 60Hz 位置/狀態流 | ❌ 未實作（僅契約定義） |

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

## 未盡事項（誠實清單）

1. realtime-lossy 通道未實作（需第二條 DataChannel 設定 maxRetransmits=0）。
2. 遊戲通道未接 Firestore 備援橋接：成員掉備援時遊戲事件到不了該成員
   （聊天已橋接）。回合制下建議 UI 以「連線降級、暫停對局」處理。
3. UI demo（房間內小遊戲）未做——本契約完成後即可在其上實作
   （game-integration-spec 里程碑 1）。
4. seq 跨頁面重載會重置（與聊天同源的已知缺口），重載即視為離席重入，
   遊戲層以 SESSION_JOIN + 快照處理。
