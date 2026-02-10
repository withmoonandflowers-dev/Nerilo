# P2P 小網狀實作計劃

## 實作階段

### 階段 1：基礎架構（1-2 週）

#### 1.1 密碼學基礎

- [ ] 實作 `IdentityManager` 類別
  - [ ] 密鑰生成（Web Crypto API）
  - [ ] 使用者 ID 生成（hash(pubKey)）
  - [ ] 公鑰匯出/匯入
  - [ ] 私鑰管理（只存在本機）

- [ ] 實作 `SecurityManager` 類別
  - [ ] 訊息簽名
  - [ ] 簽名驗證
  - [ ] 序列號檢查
  - [ ] Rate limiting

#### 1.2 訊息格式

- [ ] 定義 `GossipMessage` 介面
- [ ] 實作訊息 ID 計算
- [ ] 實作訊息序列化/反序列化

### 階段 2：拓撲管理（1-2 週）

#### 2.1 MeshTopologyManager

- [ ] 實作鄰居選擇策略
- [ ] 實作連線建立/斷開
- [ ] 實作連線旋轉（每 2 分鐘）
- [ ] 實作斷線自動補連

#### 2.2 節點發現

- [ ] 從鄰居獲取鄰居列表
- [ ] 從 Firestore 獲取房間參與者
- [ ] Bootstrap 機制

### 階段 3：Gossip 協議（1-2 週）

#### 3.1 GossipMessageHandler

- [ ] 實作訊息發送（隨機選 2 個鄰居）
- [ ] 實作訊息接收和驗證
- [ ] 實作訊息轉發（TTL 處理）
- [ ] 實作訊息去重（seenMessageIds）

#### 3.2 防護機制

- [ ] 訊息去重
- [ ] 序列號檢查
- [ ] TTL 限制
- [ ] Rate limiting

### 階段 4：整合與測試（1 週）

#### 4.1 整合到 ChatPage

- [ ] 添加 MeshGossipManager 選項
- [ ] 整合訊息顯示
- [ ] 整合訊息發送

#### 4.2 測試

- [ ] 單元測試
- [ ] 整合測試
- [ ] 壓力測試

## 實作優先順序

### 高優先級（核心功能）

1. **IdentityManager**：密鑰生成和身分管理
2. **SecurityManager**：簽名和驗證
3. **GossipMessageHandler**：基本的 gossip 傳訊
4. **MeshTopologyManager**：基本的鄰居管理

### 中優先級（優化功能）

1. **連線旋轉**：每 2 分鐘換連線
2. **節點發現**：更好的節點發現機制
3. **Rate limiting**：防止濫用

### 低優先級（進階功能）

1. **網路分區恢復**：主動同步機制
2. **連線品質評估**：基於品質選擇鄰居
3. **地理位置優化**：基於地理位置選擇鄰居

## 技術挑戰

### 1. Web Crypto API

- **挑戰**：瀏覽器相容性
- **解決**：使用 polyfill 或 fallback

### 2. Gossip 協議

- **挑戰**：確保訊息最終一致性
- **解決**：使用 TTL 和序列號

### 3. 連線管理

- **挑戰**：動態維護 k 個鄰居
- **解決**：定期旋轉和自動補連

### 4. 效能

- **挑戰**：大量訊息和簽名驗證
- **解決**：非同步處理和批次處理

## 測試計劃

### 單元測試

```typescript
describe('IdentityManager', () => {
  test('should generate key pair', async () => {
    const manager = new IdentityManager();
    const keyPair = await manager.generateKeyPair();
    expect(keyPair).toBeDefined();
  });
  
  test('should derive userId from public key', async () => {
    const manager = new IdentityManager();
    const userId = await manager.deriveUserId(publicKey);
    expect(userId).toHaveLength(32); // 16 bytes = 32 hex chars
  });
});

describe('SecurityManager', () => {
  test('should sign and verify message', async () => {
    const manager = new SecurityManager();
    const message = createTestMessage();
    const signature = await manager.signMessage(message, privateKey);
    const isValid = await manager.verifyMessage(message, publicKey);
    expect(isValid).toBe(true);
  });
});
```

### 整合測試

```typescript
describe('MeshGossipManager', () => {
  test('3 users should form mesh and exchange messages', async () => {
    const manager1 = new MeshGossipManager('room-1', 'user-1');
    const manager2 = new MeshGossipManager('room-1', 'user-2');
    const manager3 = new MeshGossipManager('room-1', 'user-3');
    
    // 建立連線
    await manager1.connectToNeighbors(['user-2', 'user-3']);
    await manager2.connectToNeighbors(['user-1', 'user-3']);
    await manager3.connectToNeighbors(['user-1', 'user-2']);
    
    // 發送訊息
    await manager1.sendMessage('Hello from user-1');
    
    // 驗證訊息擴散
    await waitFor(() => {
      expect(manager2.getReceivedMessages()).toContain('Hello from user-1');
      expect(manager3.getReceivedMessages()).toContain('Hello from user-1');
    });
  });
});
```

## 風險評估

### 高風險

1. **Web Crypto API 相容性**：某些舊瀏覽器可能不支援
2. **Gossip 協議複雜度**：實作和測試都較複雜
3. **效能問題**：大量訊息和簽名驗證可能影響效能

### 中風險

1. **連線管理**：動態維護連線可能不穩定
2. **網路分區**：分區恢復機制可能不完善

### 低風險

1. **向後兼容**：可以與現有系統並存

## 建議

### 1. 分階段實作

- 先實作核心功能（密鑰、簽名、基本 gossip）
- 再實作優化功能（連線旋轉、節點發現）
- 最後實作進階功能（分區恢復、品質評估）

### 2. 與現有系統並存

- 保持現有的 P2PManager 和 MultiP2PManager
- 新架構作為可選功能
- 可以通過配置選擇使用哪種架構

### 3. 充分測試

- 單元測試覆蓋核心邏輯
- 整合測試驗證端到端功能
- 壓力測試驗證效能

### 4. 文檔完善

- API 文檔
- 架構文檔
- 使用指南
