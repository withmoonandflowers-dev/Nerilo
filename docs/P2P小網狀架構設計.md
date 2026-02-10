# P2P 小網狀架構設計（Gossip + 簽名驗證）

## 整體設計（一句話）

每個人只連少數鄰居（k=6），用 gossip 傳訊；進房間時建立公私鑰；每則訊息用私鑰簽名，其他人即時驗簽。

## 架構概述

### 核心概念

1. **小網狀拓撲**：每個人維持 k=6 條鄰居連線（而非全連接）
2. **Gossip 協議**：訊息通過隨機轉發擴散到整個網路
3. **密碼學簽名**：每則訊息用私鑰簽名，防止串改和冒名
4. **容錯性**：部分節點斷線不影響整體網路運作

### 與現有架構的差異

| 特性 | 現有（星型拓撲） | 新架構（小網狀） |
|------|----------------|----------------|
| 連線方式 | 房主作為中心節點 | 每個人連 k 個鄰居 |
| 訊息路由 | 房主轉發 | Gossip 擴散 |
| 連線數量 | n-1（房主） | k（每個人） |
| 容錯性 | 房主斷線 = 全斷 | 部分節點斷線仍可運作 |
| 安全性 | 無簽名驗證 | 公私鑰簽名 |
| 複雜度 | 低 | 中高 |

## 1️⃣ 進入房間（身分建立）

### 流程

```
1. 客戶端本地產生或載入一組 公鑰/私鑰
2. userId = hash(pubKey)（作為使用者身分）
3. 將 userId + pubKey 廣播給鄰居（或透過 bootstrap）
4. 私鑰只存在本機，永不外傳
```

### 實作細節

#### 1.1 密鑰生成

```typescript
// 使用 Web Crypto API 生成 ECDSA 密鑰對
async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256', // 256-bit 曲線
    },
    true, // 可匯出
    ['sign', 'verify']
  );
}
```

#### 1.2 使用者 ID 生成

```typescript
async function deriveUserId(publicKey: CryptoKey): Promise<string> {
  // 匯出公鑰
  const exportedKey = await crypto.subtle.exportKey('spki', publicKey);
  
  // 計算 SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', exportedKey);
  
  // 轉換為 hex string（前 16 字元作為 userId）
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

#### 1.3 身分廣播

```typescript
interface IdentityMessage {
  type: 'IDENTITY';
  userId: string;
  pubKey: string; // Base64 編碼的公鑰
  timestamp: number;
}

// 進入房間時廣播身分
async function broadcastIdentity(neighbors: P2PConnection[]) {
  const identityMsg: IdentityMessage = {
    type: 'IDENTITY',
    userId: this.userId,
    pubKey: await this.exportPublicKey(),
    timestamp: Date.now(),
  };
  
  // 廣播給所有鄰居
  for (const neighbor of neighbors) {
    await neighbor.send(identityMsg);
  }
}
```

## 2️⃣ 連線方式（小網狀）

### 拓撲結構

```
        [User1]
         / | \
        /  |  \
   [User2][User3][User4]
    / |     |      | \
   /  |     |      |  \
[User5][User6] [User7][User8]
```

- 每個人維持 k=6 條鄰居連線
- 連線是雙向的（如果 A 連 B，B 也連 A）

### 連線管理

#### 2.1 鄰居選擇策略

```typescript
class MeshTopologyManager {
  private neighbors: Map<string, P2PConnection> = new Map();
  private readonly k = 6; // 目標鄰居數量
  private readonly maxNeighbors = 8; // 最大鄰居數量（允許超額）
  
  /**
   * 選擇鄰居的策略：
   * 1. 優先選擇連線品質好的節點
   * 2. 避免選擇已經有很多連線的節點（避免中心化）
   * 3. 優先選擇地理位置相近的節點（如果可用）
   */
  async selectNeighbors(availableNodes: string[]): Promise<string[]> {
    // 過濾掉已經是鄰居的節點
    const candidates = availableNodes.filter(
      nodeId => !this.neighbors.has(nodeId) && nodeId !== this.localUserId
    );
    
    // 評分並排序（簡化版：隨機選擇）
    const selected = candidates
      .sort(() => Math.random() - 0.5)
      .slice(0, this.k - this.neighbors.size);
    
    return selected;
  }
}
```

#### 2.2 連線維護

```typescript
class MeshTopologyManager {
  private rotationInterval: NodeJS.Timeout | null = null;
  
  /**
   * 每 2 分鐘隨機換掉 1 條連線
   */
  startRotation(): void {
    this.rotationInterval = setInterval(() => {
      this.rotateConnection();
    }, 2 * 60 * 1000); // 2 分鐘
  }
  
  private async rotateConnection(): Promise<void> {
    if (this.neighbors.size < this.k) {
      // 如果鄰居不足，先補滿
      await this.fillNeighbors();
      return;
    }
    
    // 隨機選擇一條連線替換
    const neighborsArray = Array.from(this.neighbors.keys());
    const toRemove = neighborsArray[Math.floor(Math.random() * neighborsArray.length)];
    
    // 斷開舊連線
    await this.removeNeighbor(toRemove);
    
    // 建立新連線
    await this.fillNeighbors();
  }
  
  /**
   * 斷線自動補連
   */
  async handleNeighborDisconnected(neighborId: string): Promise<void> {
    this.neighbors.delete(neighborId);
    
    // 立即補連
    await this.fillNeighbors();
  }
}
```

## 3️⃣ 訊息格式（固定）

### 訊息結構

```typescript
interface GossipMessage {
  roomId: string;
  senderId: string; // hash(pubKey)
  pubKey: string; // Base64 編碼的公鑰
  seq: number; // 序列號（防止重放）
  timestamp: number;
  content: string;
  ttl: number; // Time To Live（跳數限制）
  signature: string; // Base64 編碼的簽名
}

// 計算訊息 ID（用於去重）
function getMessageId(msg: GossipMessage): string {
  const content = JSON.stringify({
    roomId: msg.roomId,
    senderId: msg.senderId,
    seq: msg.seq,
    timestamp: msg.timestamp,
    content: msg.content,
  });
  
  // 使用 SHA-256 hash
  return hash(content);
}
```

### 簽名生成

```typescript
async function signMessage(
  message: Omit<GossipMessage, 'signature'>,
  privateKey: CryptoKey
): Promise<string> {
  // 將訊息（除 signature 外）序列化
  const messageData = JSON.stringify({
    roomId: message.roomId,
    senderId: message.senderId,
    pubKey: message.pubKey,
    seq: message.seq,
    timestamp: message.timestamp,
    content: message.content,
    ttl: message.ttl,
  });
  
  // 計算 hash
  const messageHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(messageData)
  );
  
  // 使用私鑰簽名
  const signature = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    privateKey,
    messageHash
  );
  
  // 轉換為 Base64
  return arrayBufferToBase64(signature);
}
```

### 簽名驗證

```typescript
async function verifyMessage(
  message: GossipMessage,
  publicKey: CryptoKey
): Promise<boolean> {
  // 提取簽名
  const signature = base64ToArrayBuffer(message.signature);
  
  // 重新計算訊息 hash
  const messageData = JSON.stringify({
    roomId: message.roomId,
    senderId: message.senderId,
    pubKey: message.pubKey,
    seq: message.seq,
    timestamp: message.timestamp,
    content: message.content,
    ttl: message.ttl,
  });
  
  const messageHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(messageData)
  );
  
  // 驗證簽名
  return await crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    publicKey,
    signature,
    messageHash
  );
}
```

## 4️⃣ 傳訊方式（gossip）

### 發送流程

```typescript
class GossipMessageHandler {
  private seq = 0; // 序列號計數器
  private seenMessageIds: Set<string> = new Set(); // 已見過的訊息 ID
  
  /**
   * 發送訊息
   */
  async sendMessage(content: string, roomId: string): Promise<void> {
    // 1. seq += 1
    this.seq++;
    
    // 2. 建立訊息（不含簽名）
    const message: Omit<GossipMessage, 'signature'> = {
      roomId,
      senderId: this.userId,
      pubKey: await this.exportPublicKey(),
      seq: this.seq,
      timestamp: Date.now(),
      content,
      ttl: 8, // 預設 TTL
    };
    
    // 3. 對訊息內容簽名
    const signature = await signMessage(message, this.privateKey);
    const signedMessage: GossipMessage = { ...message, signature };
    
    // 4. 傳給隨機選的 2 個鄰居
    const neighbors = Array.from(this.topologyManager.getNeighbors());
    const selectedNeighbors = this.selectRandomNeighbors(neighbors, 2);
    
    for (const neighbor of selectedNeighbors) {
      await neighbor.send(signedMessage);
    }
    
    // 5. 記錄已發送（避免重複處理自己的訊息）
    const messageId = getMessageId(signedMessage);
    this.seenMessageIds.add(messageId);
    
    // 6. 通知本地監聽器
    this.notifyMessageListeners(signedMessage);
  }
  
  /**
   * 隨機選擇鄰居
   */
  private selectRandomNeighbors(
    neighbors: P2PConnection[],
    count: number
  ): P2PConnection[] {
    const shuffled = [...neighbors].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, neighbors.length));
  }
}
```

### 接收流程

```typescript
class GossipMessageHandler {
  /**
   * 接收訊息
   */
  async handleReceivedMessage(
    message: GossipMessage,
    fromNeighbor: string
  ): Promise<void> {
    // 1. 若 messageId 已看過 → 丟棄
    const messageId = getMessageId(message);
    if (this.seenMessageIds.has(messageId)) {
      return; // 已處理過，丟棄
    }
    
    // 2. 用 pubKey 驗簽（失敗就丟）
    const publicKey = await importPublicKey(message.pubKey);
    const isValid = await verifyMessage(message, publicKey);
    
    if (!isValid) {
      console.warn('[Gossip] Invalid signature, dropping message', {
        messageId,
        senderId: message.senderId,
      });
      return; // 簽名無效，丟棄
    }
    
    // 3. 檢查序列號（防止重放）
    if (!this.checkSequence(message.senderId, message.seq)) {
      console.warn('[Gossip] Invalid sequence, dropping message', {
        messageId,
        senderId: message.senderId,
        seq: message.seq,
      });
      return; // 序列號無效，丟棄
    }
    
    // 4. 記錄已見過
    this.seenMessageIds.add(messageId);
    
    // 5. 顯示訊息
    this.notifyMessageListeners(message);
    
    // 6. ttl -= 1
    message.ttl -= 1;
    
    // 7. 若 ttl > 0 → 隨機轉發給 2 個鄰居（不含來源）
    if (message.ttl > 0) {
      await this.forwardMessage(message, fromNeighbor);
    }
  }
  
  /**
   * 轉發訊息
   */
  private async forwardMessage(
    message: GossipMessage,
    excludeNeighbor: string
  ): Promise<void> {
    const neighbors = Array.from(this.topologyManager.getNeighbors())
      .filter(n => n.getId() !== excludeNeighbor);
    
    const selectedNeighbors = this.selectRandomNeighbors(neighbors, 2);
    
    for (const neighbor of selectedNeighbors) {
      await neighbor.send(message);
    }
  }
  
  /**
   * 檢查序列號（防止重放）
   */
  private checkSequence(senderId: string, seq: number): boolean {
    const lastSeq = this.lastSeenSeq.get(senderId) || 0;
    
    if (seq <= lastSeq) {
      // 序列號必須遞增
      return false;
    }
    
    // 更新最後看到的序列號
    this.lastSeenSeq.set(senderId, seq);
    return true;
  }
}
```

## 5️⃣ 防護機制（最低限度）

### 5.1 訊息去重

```typescript
class GossipMessageHandler {
  private seenMessageIds: Set<string> = new Set();
  private readonly MAX_SEEN_SIZE = 10000; // 最多記錄 10000 條訊息 ID
  
  /**
   * 清理舊的訊息 ID（避免記憶體爆炸）
   */
  private cleanupSeenIds(): void {
    if (this.seenMessageIds.size > this.MAX_SEEN_SIZE) {
      // 簡單策略：清空一半
      const idsArray = Array.from(this.seenMessageIds);
      const toKeep = idsArray.slice(0, this.MAX_SEEN_SIZE / 2);
      this.seenMessageIds = new Set(toKeep);
    }
  }
}
```

### 5.2 序列號檢查

```typescript
class GossipMessageHandler {
  private lastSeenSeq: Map<string, number> = new Map();
  
  /**
   * 檢查序列號
   */
  private checkSequence(senderId: string, seq: number): boolean {
    const lastSeq = this.lastSeenSeq.get(senderId) || 0;
    
    // 允許一定的序列號間隙（處理網路延遲）
    const MAX_SEQ_GAP = 100;
    
    if (seq <= lastSeq) {
      return false; // 舊訊息或重放
    }
    
    if (seq > lastSeq + MAX_SEQ_GAP) {
      // 序列號跳躍太大，可能是攻擊
      console.warn('[Gossip] Large sequence gap', {
        senderId,
        lastSeq,
        seq,
      });
      // 可以選擇拒絕或接受（這裡選擇接受，但記錄警告）
    }
    
    this.lastSeenSeq.set(senderId, seq);
    return true;
  }
}
```

### 5.3 TTL 限制

```typescript
class GossipMessageHandler {
  /**
   * 檢查 TTL
   */
  private checkTTL(message: GossipMessage): boolean {
    if (message.ttl <= 0) {
      return false; // TTL 已耗盡
    }
    
    // 可以添加額外檢查：訊息年齡
    const messageAge = Date.now() - message.timestamp;
    const MAX_MESSAGE_AGE = 5 * 60 * 1000; // 5 分鐘
    
    if (messageAge > MAX_MESSAGE_AGE) {
      return false; // 訊息太舊
    }
    
    return true;
  }
}
```

### 5.4 Rate Limiting

```typescript
class GossipMessageHandler {
  private sendRateLimiter: Map<string, number[]> = new Map();
  private readonly MAX_MESSAGES_PER_SECOND = 10;
  
  /**
   * 檢查發送速率
   */
  private checkSendRate(senderId: string): boolean {
    const now = Date.now();
    const timestamps = this.sendRateLimiter.get(senderId) || [];
    
    // 清理 1 秒前的記錄
    const recentTimestamps = timestamps.filter(
      ts => now - ts < 1000
    );
    
    if (recentTimestamps.length >= this.MAX_MESSAGES_PER_SECOND) {
      console.warn('[Gossip] Rate limit exceeded', { senderId });
      return false; // 超過速率限制
    }
    
    // 記錄本次發送
    recentTimestamps.push(now);
    this.sendRateLimiter.set(senderId, recentTimestamps);
    
    return true;
  }
}
```

## 6️⃣ 斷線處理

### 6.1 鄰居斷線處理

```typescript
class MeshTopologyManager {
  /**
   * 處理鄰居斷線
   */
  async handleNeighborDisconnected(neighborId: string): Promise<void> {
    console.log('[Mesh] Neighbor disconnected', { neighborId });
    
    // 1. 移除鄰居
    const neighbor = this.neighbors.get(neighborId);
    if (neighbor) {
      neighbor.close();
      this.neighbors.delete(neighborId);
    }
    
    // 2. 立即補連
    await this.fillNeighbors();
    
    // 3. 通知上層
    this.onNeighborDisconnected?.(neighborId);
  }
  
  /**
   * 補滿鄰居
   */
  private async fillNeighbors(): Promise<void> {
    const currentCount = this.neighbors.size;
    
    if (currentCount >= this.k) {
      return; // 已經足夠
    }
    
    const needed = this.k - currentCount;
    
    // 從已知節點中選擇新鄰居
    const candidates = await this.discoverNodes();
    const selected = await this.selectNeighbors(candidates);
    
    for (const nodeId of selected.slice(0, needed)) {
      await this.connectToNeighbor(nodeId);
    }
  }
}
```

### 6.2 節點發現

```typescript
class MeshTopologyManager {
  /**
   * 發現節點（Bootstrap）
   */
  async discoverNodes(): Promise<string[]> {
    // 方法 1：從現有鄰居獲取他們的鄰居列表
    const discoveredNodes = new Set<string>();
    
    for (const neighbor of this.neighbors.values()) {
      try {
        const neighborList = await neighbor.requestNeighborList();
        neighborList.forEach(nodeId => discoveredNodes.add(nodeId));
      } catch (error) {
        console.warn('[Mesh] Failed to get neighbor list', { error });
      }
    }
    
    // 方法 2：從 Firestore 獲取房間參與者列表（作為備選）
    const roomParticipants = await RoomService.getRoomParticipants(this.roomId);
    roomParticipants.forEach(uid => discoveredNodes.add(uid));
    
    return Array.from(discoveredNodes);
  }
}
```

### 6.3 短暫分區恢復

```typescript
class GossipMessageHandler {
  /**
   * 處理網路分區恢復
   */
  async handleNetworkPartitionRecovery(): Promise<void> {
    // 當連線恢復時，重新同步訊息
    // 可以通過以下方式：
    // 1. 請求鄰居的最近訊息列表
    // 2. 重新廣播自己的最近訊息
    // 3. 等待 gossip 自然擴散
    
    console.log('[Gossip] Network partition recovered, waiting for gossip propagation');
    
    // 簡單策略：等待 gossip 自然擴散
    // 複雜策略：主動請求同步（需要額外的同步協議）
  }
}
```

## 實作架構

### 類別結構

```
MeshGossipManager
├── MeshTopologyManager (管理鄰居連線)
│   ├── selectNeighbors()
│   ├── rotateConnection()
│   └── handleNeighborDisconnected()
├── IdentityManager (管理身分和密鑰)
│   ├── generateKeyPair()
│   ├── deriveUserId()
│   └── broadcastIdentity()
├── GossipMessageHandler (處理訊息)
│   ├── sendMessage()
│   ├── handleReceivedMessage()
│   └── forwardMessage()
└── SecurityManager (安全檢查)
    ├── signMessage()
    ├── verifyMessage()
    ├── checkSequence()
    └── checkSendRate()
```

### 整合到現有系統

```typescript
// 在 ChatPage 中使用
class ChatPage {
  private meshGossipManager: MeshGossipManager | null = null;
  
  async initializeMeshGossip(roomId: string, userId: string) {
    // 初始化 Mesh Gossip Manager
    this.meshGossipManager = new MeshGossipManager(roomId, userId);
    
    // 建立身分
    await this.meshGossipManager.establishIdentity();
    
    // 建立鄰居連線
    await this.meshGossipManager.connectToNeighbors();
    
    // 監聽訊息
    this.meshGossipManager.onMessage((message) => {
      this.handleMessage(message);
    });
  }
}
```

## 優化建議

### 1. 鄰居選擇策略

- **連線品質**：優先選擇延遲低、頻寬高的節點
- **負載均衡**：避免選擇已經有很多連線的節點
- **地理位置**：優先選擇地理位置相近的節點（如果可用）

### 2. Gossip 參數調整

- **轉發數量**：可以動態調整（例如：根據網路大小）
- **TTL**：可以根據房間大小調整
- **轉發機率**：可以加入機率性轉發（例如：80% 機率轉發）

### 3. 效能優化

- **批次處理**：批量處理多條訊息
- **非同步處理**：簽名驗證可以非同步進行
- **快取**：快取公鑰，避免重複匯入

## 測試建議

### 1. 單元測試

- 密鑰生成和簽名驗證
- 訊息去重邏輯
- 序列號檢查
- Rate limiting

### 2. 整合測試

- 3 人小網狀連線
- 5 人小網狀連線
- 10 人小網狀連線
- 節點斷線和恢復

### 3. 壓力測試

- 大量訊息傳輸
- 高頻率發送
- 網路分區恢復

## 與現有系統的整合

### 遷移策略

1. **階段 1**：實作 MeshGossipManager，與現有 P2PManager 並存
2. **階段 2**：在 ChatPage 中添加選項，選擇使用哪種架構
3. **階段 3**：逐步遷移到新架構
4. **階段 4**：移除舊的星型拓撲架構（可選）

### 向後兼容

- 保持現有的 P2PManager 和 MultiP2PManager
- 新架構作為可選功能
- 可以通過配置選擇使用哪種架構
