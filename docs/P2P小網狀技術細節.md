# P2P 小網狀架構技術細節

## 核心類別設計

### 1. IdentityManager（身分管理）

```typescript
export class IdentityManager {
  private keyPair: CryptoKeyPair | null = null;
  private userId: string | null = null;
  
  /**
   * 生成或載入密鑰對
   */
  async initialize(): Promise<void> {
    // 嘗試從 IndexedDB 載入
    const savedKeyPair = await this.loadKeyPairFromStorage();
    
    if (savedKeyPair) {
      this.keyPair = savedKeyPair;
    } else {
      // 生成新密鑰對
      this.keyPair = await this.generateKeyPair();
      await this.saveKeyPairToStorage(this.keyPair);
    }
    
    // 計算 userId
    this.userId = await this.deriveUserId(this.keyPair.publicKey);
  }
  
  /**
   * 生成 ECDSA 密鑰對
   */
  private async generateKeyPair(): Promise<CryptoKeyPair> {
    return await crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true, // 可匯出
      ['sign', 'verify']
    );
  }
  
  /**
   * 從公鑰計算 userId
   */
  async deriveUserId(publicKey: CryptoKey): Promise<string> {
    const exportedKey = await crypto.subtle.exportKey('spki', publicKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', exportedKey);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  /**
   * 匯出公鑰（Base64）
   */
  async exportPublicKey(): Promise<string> {
    if (!this.keyPair) throw new Error('Key pair not initialized');
    const exported = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    return arrayBufferToBase64(exported);
  }
  
  getUserId(): string {
    if (!this.userId) throw new Error('User ID not initialized');
    return this.userId;
  }
  
  getPrivateKey(): CryptoKey {
    if (!this.keyPair) throw new Error('Key pair not initialized');
    return this.keyPair.privateKey;
  }
}
```

### 2. SecurityManager（安全管理）

```typescript
export class SecurityManager {
  /**
   * 簽名訊息
   */
  async signMessage(
    message: Omit<GossipMessage, 'signature'>,
    privateKey: CryptoKey
  ): Promise<string> {
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
    
    const signature = await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      privateKey,
      messageHash
    );
    
    return arrayBufferToBase64(signature);
  }
  
  /**
   * 驗證訊息簽名
   */
  async verifyMessage(
    message: GossipMessage,
    publicKey: CryptoKey
  ): Promise<boolean> {
    const signature = base64ToArrayBuffer(message.signature);
    
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
  
  /**
   * 匯入公鑰
   */
  async importPublicKey(pubKeyBase64: string): Promise<CryptoKey> {
    const keyData = base64ToArrayBuffer(pubKeyBase64);
    return await crypto.subtle.importKey(
      'spki',
      keyData,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      false, // 不可匯出
      ['verify']
    );
  }
}
```

### 3. MeshTopologyManager（拓撲管理）

```typescript
export class MeshTopologyManager {
  private neighbors: Map<string, MeshConnection> = new Map();
  private readonly k = 6; // 目標鄰居數量
  private rotationInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private roomId: string,
    private localUserId: string
  ) {}
  
  /**
   * 建立鄰居連線
   */
  async connectToNeighbors(targetNodeIds: string[]): Promise<void> {
    for (const nodeId of targetNodeIds) {
      if (this.neighbors.size >= this.k) break;
      if (this.neighbors.has(nodeId)) continue;
      
      try {
        const connection = await this.createConnection(nodeId);
        this.neighbors.set(nodeId, connection);
        
        // 監聽斷線
        connection.onDisconnect(() => {
          this.handleNeighborDisconnected(nodeId);
        });
      } catch (error) {
        console.warn('[Mesh] Failed to connect to neighbor', { nodeId, error });
      }
    }
  }
  
  /**
   * 處理鄰居斷線
   */
  private async handleNeighborDisconnected(neighborId: string): Promise<void> {
    this.neighbors.delete(neighborId);
    await this.fillNeighbors();
  }
  
  /**
   * 補滿鄰居
   */
  private async fillNeighbors(): Promise<void> {
    if (this.neighbors.size >= this.k) return;
    
    const candidates = await this.discoverNodes();
    const needed = this.k - this.neighbors.size;
    const selected = await this.selectNeighbors(candidates, needed);
    
    await this.connectToNeighbors(selected);
  }
  
  /**
   * 開始連線旋轉
   */
  startRotation(): void {
    this.rotationInterval = setInterval(() => {
      this.rotateConnection();
    }, 2 * 60 * 1000); // 2 分鐘
  }
  
  /**
   * 旋轉一條連線
   */
  private async rotateConnection(): Promise<void> {
    if (this.neighbors.size < this.k) {
      await this.fillNeighbors();
      return;
    }
    
    const neighborsArray = Array.from(this.neighbors.keys());
    const toRemove = neighborsArray[Math.floor(Math.random() * neighborsArray.length)];
    
    this.neighbors.get(toRemove)?.close();
    this.neighbors.delete(toRemove);
    
    await this.fillNeighbors();
  }
  
  /**
   * 發現節點
   */
  private async discoverNodes(): Promise<string[]> {
    const discoveredNodes = new Set<string>();
    
    // 從鄰居獲取他們的鄰居列表
    for (const neighbor of this.neighbors.values()) {
      try {
        const neighborList = await neighbor.requestNeighborList();
        neighborList.forEach(nodeId => discoveredNodes.add(nodeId));
      } catch (error) {
        // 忽略錯誤
      }
    }
    
    // 從 Firestore 獲取房間參與者
    const roomParticipants = await RoomService.getRoomParticipants(this.roomId);
    roomParticipants.forEach(uid => discoveredNodes.add(uid));
    
    return Array.from(discoveredNodes).filter(id => id !== this.localUserId);
  }
  
  /**
   * 選擇鄰居
   */
  private async selectNeighbors(
    candidates: string[],
    count: number
  ): Promise<string[]> {
    // 簡單策略：隨機選擇
    // 未來可以加入連線品質評估
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
  
  /**
   * 獲取所有鄰居
   */
  getNeighbors(): MeshConnection[] {
    return Array.from(this.neighbors.values());
  }
  
  /**
   * 清理資源
   */
  cleanup(): void {
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
      this.rotationInterval = null;
    }
    
    this.neighbors.forEach(neighbor => neighbor.close());
    this.neighbors.clear();
  }
}
```

### 4. GossipMessageHandler（Gossip 處理）

```typescript
export class GossipMessageHandler {
  private seq = 0;
  private seenMessageIds: Set<string> = new Set();
  private lastSeenSeq: Map<string, number> = new Map();
  private sendRateLimiter: Map<string, number[]> = new Map();
  private messageListeners: Set<(message: GossipMessage) => void> = new Set();
  
  constructor(
    private roomId: string,
    private userId: string,
    private identityManager: IdentityManager,
    private securityManager: SecurityManager,
    private topologyManager: MeshTopologyManager
  ) {}
  
  /**
   * 發送訊息
   */
  async sendMessage(content: string): Promise<void> {
    // Rate limiting
    if (!this.checkSendRate(this.userId)) {
      throw new Error('Rate limit exceeded');
    }
    
    // seq += 1
    this.seq++;
    
    // 建立訊息
    const message: Omit<GossipMessage, 'signature'> = {
      roomId: this.roomId,
      senderId: this.userId,
      pubKey: await this.identityManager.exportPublicKey(),
      seq: this.seq,
      timestamp: Date.now(),
      content,
      ttl: 8,
    };
    
    // 簽名
    const signature = await this.securityManager.signMessage(
      message,
      this.identityManager.getPrivateKey()
    );
    
    const signedMessage: GossipMessage = { ...message, signature };
    
    // 傳給隨機選的 2 個鄰居
    const neighbors = this.topologyManager.getNeighbors();
    const selected = this.selectRandomNeighbors(neighbors, 2);
    
    for (const neighbor of selected) {
      await neighbor.send(signedMessage);
    }
    
    // 記錄已發送
    const messageId = this.getMessageId(signedMessage);
    this.seenMessageIds.add(messageId);
    
    // 通知本地監聽器
    this.notifyMessageListeners(signedMessage);
  }
  
  /**
   * 處理接收到的訊息
   */
  async handleReceivedMessage(
    message: GossipMessage,
    fromNeighbor: string
  ): Promise<void> {
    // 檢查是否已見過
    const messageId = this.getMessageId(message);
    if (this.seenMessageIds.has(messageId)) {
      return; // 已處理過
    }
    
    // 驗證簽名
    const publicKey = await this.securityManager.importPublicKey(message.pubKey);
    const isValid = await this.securityManager.verifyMessage(message, publicKey);
    
    if (!isValid) {
      console.warn('[Gossip] Invalid signature', { messageId });
      return; // 簽名無效
    }
    
    // 檢查序列號
    if (!this.checkSequence(message.senderId, message.seq)) {
      console.warn('[Gossip] Invalid sequence', { messageId });
      return; // 序列號無效
    }
    
    // 記錄已見過
    this.seenMessageIds.add(messageId);
    
    // 顯示訊息
    this.notifyMessageListeners(message);
    
    // 轉發（如果 TTL > 0）
    if (message.ttl > 0) {
      message.ttl -= 1;
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
    const neighbors = this.topologyManager.getNeighbors()
      .filter(n => n.getId() !== excludeNeighbor);
    
    const selected = this.selectRandomNeighbors(neighbors, 2);
    
    for (const neighbor of selected) {
      await neighbor.send(message);
    }
  }
  
  /**
   * 計算訊息 ID
   */
  private getMessageId(message: GossipMessage): string {
    const content = JSON.stringify({
      roomId: message.roomId,
      senderId: message.senderId,
      seq: message.seq,
      timestamp: message.timestamp,
      content: message.content,
    });
    
    // 使用 SHA-256 hash（簡化版，實際應該使用非同步）
    return hash(content);
  }
  
  /**
   * 檢查序列號
   */
  private checkSequence(senderId: string, seq: number): boolean {
    const lastSeq = this.lastSeenSeq.get(senderId) || 0;
    
    if (seq <= lastSeq) {
      return false; // 舊訊息或重放
    }
    
    this.lastSeenSeq.set(senderId, seq);
    return true;
  }
  
  /**
   * 檢查發送速率
   */
  private checkSendRate(senderId: string): boolean {
    const now = Date.now();
    const timestamps = this.sendRateLimiter.get(senderId) || [];
    const recent = timestamps.filter(ts => now - ts < 1000);
    
    if (recent.length >= 10) {
      return false; // 超過速率限制
    }
    
    recent.push(now);
    this.sendRateLimiter.set(senderId, recent);
    return true;
  }
  
  /**
   * 隨機選擇鄰居
   */
  private selectRandomNeighbors(
    neighbors: MeshConnection[],
    count: number
  ): MeshConnection[] {
    const shuffled = [...neighbors].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, neighbors.length));
  }
  
  /**
   * 監聽訊息
   */
  onMessage(listener: (message: GossipMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }
  
  /**
   * 通知監聽器
   */
  private notifyMessageListeners(message: GossipMessage): void {
    this.messageListeners.forEach(listener => {
      try {
        listener(message);
      } catch (error) {
        console.error('[Gossip] Error in message listener', { error });
      }
    });
  }
}
```

### 5. MeshGossipManager（主管理器）

```typescript
export class MeshGossipManager {
  private identityManager: IdentityManager;
  private securityManager: SecurityManager;
  private topologyManager: MeshTopologyManager;
  private messageHandler: GossipMessageHandler;
  
  constructor(
    private roomId: string
  ) {
    this.identityManager = new IdentityManager();
    this.securityManager = new SecurityManager();
    this.topologyManager = new MeshTopologyManager(roomId, '');
    this.messageHandler = new GossipMessageHandler(
      roomId,
      '',
      this.identityManager,
      this.securityManager,
      this.topologyManager
    );
  }
  
  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    // 1. 建立身分
    await this.identityManager.initialize();
    const userId = this.identityManager.getUserId();
    
    // 更新 topologyManager 和 messageHandler 的 userId
    this.topologyManager['localUserId'] = userId;
    this.messageHandler['userId'] = userId;
    
    // 2. 廣播身分
    await this.broadcastIdentity();
    
    // 3. 建立鄰居連線
    await this.topologyManager.connectToNeighbors([]);
    
    // 4. 開始連線旋轉
    this.topologyManager.startRotation();
  }
  
  /**
   * 廣播身分
   */
  private async broadcastIdentity(): Promise<void> {
    const identityMsg = {
      type: 'IDENTITY',
      userId: this.identityManager.getUserId(),
      pubKey: await this.identityManager.exportPublicKey(),
      timestamp: Date.now(),
    };
    
    // 透過 Firestore 廣播（或直接給鄰居）
    // 這裡簡化處理
  }
  
  /**
   * 發送訊息
   */
  async sendMessage(content: string): Promise<void> {
    return await this.messageHandler.sendMessage(content);
  }
  
  /**
   * 監聽訊息
   */
  onMessage(listener: (message: GossipMessage) => void): () => void {
    return this.messageHandler.onMessage(listener);
  }
  
  /**
   * 清理資源
   */
  cleanup(): void {
    this.topologyManager.cleanup();
  }
}
```

## 輔助函數

```typescript
/**
 * ArrayBuffer 轉 Base64
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 轉 ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 計算 hash（簡化版，實際應該使用非同步）
 */
function hash(content: string): string {
  // 這裡應該使用 crypto.subtle.digest，但為了簡化先這樣
  // 實際實作應該是非同步的
  return btoa(content).substring(0, 32);
}
```

## 使用範例

```typescript
// 在 ChatPage 中使用
const meshGossipManager = new MeshGossipManager(roomId);

// 初始化
await meshGossipManager.initialize();

// 監聽訊息
meshGossipManager.onMessage((message) => {
  setMessages(prev => [...prev, {
    messageId: getMessageId(message),
    from: message.senderId,
    content: message.content,
    timestamp: message.timestamp,
  }]);
});

// 發送訊息
await meshGossipManager.sendMessage('Hello, world!');
```
