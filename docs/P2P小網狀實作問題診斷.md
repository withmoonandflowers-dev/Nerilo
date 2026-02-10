# P2P 小網狀實作問題診斷

## 當前狀態

### ✅ 已完成
1. 所有核心類別已實作
2. 類型定義已更新
3. Firestore 規則已更新
4. RoomService 已更新
5. ChatPage 已整合
6. E2E 測試已建立

### ⚠️ 已知問題

#### 1. Mesh 架構未正確啟用

**問題**：E2E 測試顯示系統仍在使用傳統 P2PManager，而不是 MeshGossipManager。

**可能原因**：
1. 參與者數量檢測不正確（可能仍為 2）
2. Mesh 架構初始化失敗
3. 連線建立時間過長

**診斷步驟**：
1. 檢查 Console 日誌中的 `[ChatPage] Deciding P2P architecture`
2. 確認 `useMesh` 是否為 `true`
3. 檢查 `[MeshGossipManager]` 相關日誌

#### 2. 連線建立時間

**問題**：Mesh 架構需要建立多個連線，可能需要較長時間。

**解決方案**：
- 已將超時時間設置為 60-90 秒
- 改進連線建立邏輯（非同步建立，不等待所有連線）

#### 3. 節點發現延遲

**問題**：新節點加入時，其他節點可能需要等待 Firestore 同步。

**解決方案**：
- 已添加重試邏輯（最多 3 次）
- 已添加等待時間（2 秒）

## 調試建議

### 1. 檢查 Console 日誌

在瀏覽器 Console 中查找以下日誌：

```
[ChatPage] Deciding P2P architecture
[ChatPage] Initializing Mesh Gossip Manager
[MeshGossipManager] Initializing
[MeshGossipManager] Identity registered
[MeshTopologyManager] Initializing
[MeshTopologyManager] Selected neighbors
[MeshConnection] Initiating connection
```

### 2. 檢查參與者數量

確認房間的 `participants.length` 是否 >= 3。

### 3. 檢查 Firestore 資料

確認 `p2pRooms/{roomId}` 是否包含：
- `meshIdentities` 欄位
- `topology: 'mesh'` 欄位

### 4. 手動測試

1. 打開 3 個瀏覽器
2. 第一個建立房間
3. 第二個和第三個加入
4. 檢查 Console 日誌
5. 確認是否使用 Mesh 架構

## 修復建議

### 1. 強制使用 Mesh 架構（測試用）

在 `ChatPage` 中暫時強制使用 Mesh 架構：

```typescript
const useMesh = true; // 強制使用 Mesh（測試用）
```

### 2. 改進連線狀態檢測

確保 `getConnectionState()` 正確返回連線狀態。

### 3. 添加更多日誌

在關鍵位置添加日誌，方便診斷問題。

## 下一步

1. 運行測試並檢查日誌
2. 根據日誌診斷問題
3. 修復發現的問題
4. 重新測試
