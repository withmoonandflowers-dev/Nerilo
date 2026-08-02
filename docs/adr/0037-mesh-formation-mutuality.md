# ADR-0037：partial mesh 成形改確定性互選＋入站應答，signaling 訂閱視窗擴大

日期：2026-08-02。狀態：accepted。關聯：Spec 016、Spec 011（R-a/R-g）、ADR-0035。

## 背景

7-10 人房連線成形長期不穩，Spec 011 V1 記為「CPU 排擠、待低負載重跑」。低負載實測
推翻該解釋：一條 mesh 邊要成形，兩端都得各自建 MeshConnection，而 selectNeighbors
是隨機洗牌、reactive discovery 是發現順序取額——互選純屬機率（7 人 k=3 約 0.25/邊），
未互選的 offer 無人接聽，只能等 2 分鐘一輪的重抽。實測 101 次發起僅 17 次成形。
Spec 011 的 1100 組 seed 模擬假設 k-圖已成形，只驗擴散層，成形層從未被證明。

## 決策

1. **確定性互選**：目標集由排序名冊推導（circulant 環 C_n(1..⌈k/2⌉)，
   `core/mesh/circulantTopology.ts` 純函式）。互選由偏移集對負封閉保證；連通由環保證；
   度數 2⌈k/2⌉ 有界。full mesh 檔（k ≥ n-1）回傳全體，≤6 人房行為不變。
   發起方裁決不動（uid 序＋Spec 005 介紹覆寫）。旋轉保留（拆後重建同邊＝鏈路演練；
   非目標多餘邊拆後不重建，向 circulant 集收斂）。
2. **入站 offer 反應式應答**：MeshTopologyManager 掛房級 signaling 觀察者
   （只讀 `to==me` 的 offer），對「無對應連線物件」的 offer 建應答端，
   cap k+ACCEPT_SLACK。醫治名冊視圖分歧窗的暫時單邊嘗試。
3. **signaling 訂閱視窗 50→400**：整房升冪 limit(50) 在成形風暴期會把晚寫入的
   offer/answer 永遠擋在窗外（3 人房 <50 從不出事）。「訂閱範圍化 where to==me」
   的第一版修法在實測劣化後回退（無法乾淨歸因於同晚機器異常），改採不動 query
   形狀的視窗擴大；範圍化保留為 transport 選填參數，僅入站觀察者使用。

## 證據與殘留

- 互選對稱 property 300 輪、連通全枚舉、成形層模擬 1600 seed 全綠；
  單元 1558、3 人矩陣×3、@vue-stable、React @stable 迴歸全綠。
- 7p E2E 量測改善（發起 101→78、單邊 offer 歸零、成形 12→20、bus 逾時 106→62）
  但單機仍未全綠——開發機 7 瀏覽器併發即 Spec 011 R-g 資源上限。
  驗收移至專用 workflow `e2e-7p.yml`（乾淨 runner，手動＋每日排程）。
- 順手修：IceServerProvider 社群 TURN 清單失敗不快取（風暴期一輪 59 次重抓）。

## 補註（2026-08-03，Spec 019）：重連耗盡改降慢車道

殘留 D 收口：scheduleReconnect 快車道（指數退避 ×5）耗盡後不再永久放棄，
降 30s±10% 慢車道持久重試；每輪以「當下 snapshot」重算確定性互選目標集，
不在集內即出列（identityMap 只增不減，不可作此判準）。舊計時器的 size>=k
跳過在互選語義下會誤殺升級窗的必要重試，由目標集檢查取代。
分島最壞自癒時間從「永不」變 ~30s。證據：meshReconnectSlowLane 三性質
（fake timers，jitter 上下界推演；stash 對照修前紅）。
