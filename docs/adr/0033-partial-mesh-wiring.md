# ADR-0033：接線 partial mesh（只升不降）＋房間容量分層 Free 5／Pro 10

- 狀態：accepted（2026-07-18）
- 關聯：Spec 011（feature）、ADR-0003（分層拓撲，本 ADR 完成其「未接入」部分至 20 人檔）、
  ADR-0007（凍結類解凍首例之二，前例為 game/）、ADR-0008（Pro 權益落點）

## 背景

AdaptiveTopologyManager／SuperNodeElection 自專案初期即存在且有單元測試，但
`MeshTopologyManager.updateParticipantCount()` 全 repo 無呼叫者——自適應拓撲是死碼，
產品流恆為 full mesh（k=6、fanout 5、ttl 1）。5 人上限是 RoomService 與 firestore.rules
的產品閘門，非技術實測結果。Pro 唯一可伺服器端強制的權益（每房人數）因此懸空。

## 決策

1. **只升不降**：策略 rank 上升才整組採納；同 rank 內 k/fanout/ttl 只取 max；rank
   下降忽略。選這個而非「動態雙向切換」的原因：名冊快照低報（watch 落後）不得使運
   作中房間降級抖動；降級唯一代價是多餘連線（資源），換掉一整類切換時序風險。
   淨效果：≤6 人房行為與接線前完全一致（characterization 保證），第 7 人才首次切
   partial（k=max(3,⌈√n⌉)、fanout 3、ttl 3）。
2. **人數權威來源＝rosterFromRoom 語義**（meshIdentities ∩ participants 的
   participants 集合大小），與 keyx 同源同語義，經 MeshGossipManager 既有的
   directory watch push 通道取得——不另設輪詢。
3. **accept-slack（k+2）**：連線要雙側各建 MeshConnection 才成形；k 滿的一側若不建，
   晚到者 offer 無人接、連不進圖（anti-entropy 收斂前提是連通圖）。reactive
   discovery 對全新成員放寬到 k+2，超出部分由旋轉修剪。不做全域重平衡——10 人內
   無必要，且超出 feature 軌。
4. **橋接條件 connected < min(n-1, k)**：partial mesh 下 k < n-1 是設計常態，沿用
   n-1 會每訊息雙寫 Firestore 備援（成本與「P2P 為主」定位倒置）。已知盲點「鄰居
   健全≠全房可達」由模擬的連通性劇本看住，不假裝不存在。
5. **容量屬房主權益**：建房時依房主 plan 寫入 `maxParticipants`（Free 5／Pro 至 10），
   rules 以 `request.auth.token.plan` 驗證 >5、update 不可變；join 一律對房間文件
   容量強制（加入者方案不影響）。選「存欄位」而非「join 時看誰的 plan」：房間容量
   是房間的屬性，付費者是建房的人。legacy 房無欄位＝5，不遷移。
6. **上限 10、super-node 續凍**：8-10 檔位取上緣（10 人 k=4，多行使一檔）；>20 的
   super-node 涉及自報分數信任與樞紐元資料隱私，維持 ADR-0007 凍結。

## 後果

- 多跳擴散（ttl 3）與旋轉 churn 首次進產品流；證據分層：7-10 人 × 1100 組 seed 的
  確定性模擬（含 churn 與晚到者）＋ 7 人 E2E 矩陣（未入 @vue-stable，先累積觀察）。
- god-file 棘輪迫使新邏輯落新檔：`src/services/roomCapacity.ts`、
  `web-vue/app/composables/useMeshHealth.ts`。
- React 凍結線只改橋接期望值一行；Pro 建大房能力僅 web-vue（React 建房仍缺省 5，
  join 大房不受影響——切 Vue 前 Pro 大房入口只在 Vue 線，屬已知且可接受的過渡）。
- 旋轉 churn 若在實測暴露掉信窗，屬遷移窗同族問題，轉交 mesh-correctness 殘留第 2
  項處理，不在本 ADR 範圍內修。
