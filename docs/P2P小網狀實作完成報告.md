# P2P 小網狀架構實作完成報告

## ✅ 已完成的功能

### 1. 核心類別實作 ✅

#### 1.1 IdentityManager（身分管理）
- ✅ 密鑰對生成（ECDSA P-256）
- ✅ 使用者 ID 計算（hash(pubKey)）
- ✅ 密鑰對儲存和載入（localStorage）
- ✅ 公鑰匯出

**檔案**：`src/core/mesh/IdentityManager.ts`

#### 1.2 SecurityManager（安全管理）
- ✅ 訊息簽名
- ✅ 簽名驗證
- ✅ 公鑰匯入

**檔案**：`src/core/mesh/SecurityManager.ts`

#### 1.3 MeshConnection（Mesh 連線）
- ✅ 封裝與單個鄰居的 P2P 連線
- ✅ 使用 Firebase UID 進行 signaling
- ✅ 使用 userId 進行 Gossip 訊息傳輸
- ✅ 訊息監聽和發送

**檔案**：`src/core/mesh/MeshConnection.ts`

#### 1.4 MeshTopologyManager（拓撲管理）
- ✅ 鄰居選擇策略
- ✅ 連線建立和管理
- ✅ 連線旋轉（每 2 分鐘）
- ✅ 斷線自動補連
- ✅ 節點發現（從 Firestore 獲取）

**檔案**：`src/core/mesh/MeshTopologyManager.ts`

#### 1.5 GossipMessageHandler（Gossip 處理）
- ✅ 訊息發送（隨機選 2 個鄰居）
- ✅ 訊息接收和驗證
- ✅ 訊息轉發（TTL 處理）
- ✅ 訊息去重（seenMessageIds）
- ✅ 序列號檢查（防止重放）
- ✅ Rate limiting

**檔案**：`src/core/mesh/GossipMessageHandler.ts`

#### 1.6 MeshGossipManager（主管理器）
- ✅ 整合所有 Mesh 相關功能
- ✅ 身分註冊到 Firestore
- ✅ 拓撲初始化
- ✅ 訊息處理

**檔案**：`src/core/mesh/MeshGossipManager.ts`

#### 1.7 MeshChatService（聊天服務）
- ✅ 使用 MeshGossipManager 處理聊天
- ✅ 訊息格式轉換（GossipMessage <-> ChatMessage）
- ✅ 連線狀態管理

**檔案**：`src/features/chat/MeshChatService.ts`

### 2. 工具函數 ✅

#### 2.1 密碼學工具
- ✅ `arrayBufferToBase64` / `base64ToArrayBuffer`
- ✅ `sha256Hash`（非同步）
- ✅ `getMessageId`（用於去重）

**檔案**：`src/utils/crypto.ts`

### 3. 類型定義 ✅

#### 3.1 新增類型
- ✅ `GossipMessage` - Gossip 訊息格式
- ✅ `MeshIdentity` - Mesh 身分資訊

#### 3.2 更新類型
- ✅ `P2PRoom` - 添加 `meshIdentities` 和 `topology` 欄位

**檔案**：`src/types/index.ts`

### 4. Firestore 規則 ✅

#### 4.1 更新規則
- ✅ 允許參與者更新自己的 `meshIdentity`
- ✅ Signaling 規則保持不變（已足夠）

**檔案**：`firestore.rules`

### 5. RoomService 更新 ✅

#### 5.1 新增方法
- ✅ `updateMeshIdentity` - 更新或添加 mesh 身分
- ✅ `getMeshIdentities` - 獲取所有節點的 mesh 身分

#### 5.2 更新方法
- ✅ `getRoom` - 包含 `meshIdentities` 和 `topology`
- ✅ `subscribeRoom` - 包含 `meshIdentities` 和 `topology`

**檔案**：`src/services/RoomService.ts`

### 6. ChatPage 整合 ✅

#### 6.1 架構選擇
- ✅ 根據參與者數量或 `topology` 欄位選擇架構
- ✅ 參與者 >= 3 時自動使用 Mesh 架構
- ✅ 參與者 = 2 時使用星型拓撲

#### 6.2 整合邏輯
- ✅ 自動檢測並初始化 Mesh 架構
- ✅ 連線狀態監聽
- ✅ 訊息發送和接收

**檔案**：`src/features/chat/ChatPage.tsx`

### 7. E2E 測試 ✅

#### 7.1 測試案例
- ✅ 3 人小網狀連線測試
- ✅ 5 人小網狀連線測試

**檔案**：`tests/e2e/mesh-gossip.spec.ts`

## 📋 實作細節

### 架構選擇邏輯

```typescript
// 在 ChatPage 中
const useMesh = room.topology === 'mesh' || effectiveParticipantCount >= 3;
```

- **參與者 = 2**：使用星型拓撲（現有 P2PManager）
- **參與者 >= 3**：使用 Mesh 架構（MeshGossipManager）
- **topology = 'mesh'**：強制使用 Mesh 架構

### 身分註冊流程

1. 進入房間時，`MeshGossipManager.initialize()` 被調用
2. `IdentityManager` 生成或載入密鑰對
3. 計算 `userId = hash(pubKey)`
4. 調用 `RoomService.updateMeshIdentity()` 註冊到 Firestore
5. 其他節點可以從 Firestore 獲取身分資訊

### 連線建立流程

1. **節點發現**：從 Firestore 的 `meshIdentities` 獲取節點列表
2. **鄰居選擇**：隨機選擇 k=6 個鄰居
3. **連線建立**：使用 `MeshConnection` 建立 P2P 連線
4. **Signaling**：使用 Firebase UID 進行 WebRTC signaling
5. **Gossip**：使用 userId 進行 Gossip 訊息傳輸

### 訊息流程

1. **發送**：
   - 用戶發送訊息
   - `GossipMessageHandler.sendMessage()` 簽名並發送
   - 隨機選 2 個鄰居發送

2. **接收**：
   - 鄰居收到訊息
   - 驗證簽名
   - 檢查序列號和 TTL
   - 顯示訊息
   - 如果 TTL > 0，轉發給其他 2 個鄰居

## 🔧 已知問題和限制

### 1. 連線建立時間

- **問題**：Mesh 架構需要建立多個連線，可能需要較長時間
- **影響**：E2E 測試可能需要更長的超時時間
- **解決**：已將超時時間設置為 60-90 秒

### 2. 節點發現延遲

- **問題**：新節點加入時，其他節點可能需要等待 Firestore 同步
- **影響**：連線建立可能延遲
- **解決**：在 `discoverNodes` 中添加重試邏輯（可選）

### 3. Signaling 使用 Firebase UID

- **設計**：MeshConnection 使用 Firebase UID 進行 signaling（因為 P2PConnectionManager 依賴它）
- **影響**：Signaling 和 Gossip 使用不同的 ID 系統
- **解決**：這是設計選擇，確保與現有系統兼容

### 4. 連線旋轉

- **實作**：每 2 分鐘隨機換掉 1 條連線
- **限制**：目前使用簡單的隨機選擇，未來可以加入連線品質評估

## 🧪 測試狀態

### E2E 測試

- **狀態**：已建立，但可能需要調整超時時間
- **測試案例**：
  - 3 人小網狀連線
  - 5 人小網狀連線

### 單元測試

- **狀態**：待建立
- **建議**：為核心類別建立單元測試

## 📝 使用說明

### 自動啟用

系統會根據參與者數量自動選擇架構：
- **2 人**：星型拓撲
- **3+ 人**：Mesh 架構

### 手動啟用

可以在建立房間時設置 `topology: 'mesh'` 來強制使用 Mesh 架構。

### 驗證

1. 打開瀏覽器 Console
2. 查看 `[MeshGossipManager]` 相關日誌
3. 確認身分註冊和連線建立

## 🎯 後續優化建議

### 1. 連線品質評估

- 監控每個連線的延遲和頻寬
- 優先選擇品質好的節點作為鄰居

### 2. 節點發現優化

- 從鄰居獲取他們的鄰居列表
- 實現更高效的節點發現機制

### 3. 連線狀態監控

- 顯示每個鄰居的連線狀態
- 提供更詳細的連線資訊

### 4. 效能優化

- 批次處理多條訊息
- 快取公鑰，避免重複匯入
- 優化訊息去重邏輯

## 總結

### ✅ 已完成

1. **核心類別**：所有核心類別已實作
2. **類型定義**：所有類型已定義
3. **Firestore 規則**：規則已更新
4. **RoomService**：相關方法已添加
5. **ChatPage 整合**：已整合 Mesh 架構
6. **E2E 測試**：測試案例已建立

### 📋 待優化

1. **連線建立時間**：可能需要優化
2. **節點發現**：可以加入更多機制
3. **連線品質**：可以加入品質評估
4. **單元測試**：建議建立單元測試

### 🎯 建議

1. **先測試基本功能**：確保 3 人連線可以正常運作
2. **再測試多人場景**：測試 5+ 人連線
3. **優化效能**：根據測試結果優化
4. **添加監控**：添加更詳細的日誌和監控
