# Firestore 結構與規則分析（P2P 小網狀架構）

## 現有 Firestore 結構

### 現有集合

1. **`p2pRooms/{roomId}`** - 房間資料
   ```typescript
   {
     ownerUid: string;
     ownerName?: string;
     participants: string[]; // Firebase Auth UID 列表
     status: 'waiting' | 'open' | 'closed';
     isPrivate: boolean;
     createdAt: Timestamp;
     waitingTimeout?: number;
     waitingStartedAt?: Timestamp;
   }
   ```

2. **`p2pRooms/{roomId}/signals/{signalId}`** - WebRTC Signaling
   ```typescript
   {
     from: string; // Firebase Auth UID
     to?: string; // Firebase Auth UID（可選）
     type: 'offer' | 'answer' | 'ice';
     payload: any; // WebRTC SDP 或 ICE candidate
     createdAt: Timestamp;
   }
   ```

## 新架構需求分析

### 1. 身分資訊儲存

**需求**：
- 需要儲存 `userId`（hash(pubKey)）和 `pubKey` 的對應關係
- 用於節點發現和身分驗證

**選項 A：使用現有結構（推薦）**
- 在 `p2pRooms/{roomId}` 中添加 `meshIdentities` 欄位
- 格式：`Map<userId, pubKey>`

**選項 B：新增子集合**
- 新增 `p2pRooms/{roomId}/meshIdentities/{userId}`
- 每個節點一個文件

**選項 C：不儲存（純 P2P）**
- 身分資訊只透過 P2P 傳遞
- 節點發現只依賴 `participants` 列表

### 2. 節點發現

**需求**：
- 需要知道房間內有哪些節點
- 用於建立鄰居連線

**現有方案**：
- ✅ 可以使用 `p2pRooms/{roomId}.participants` 列表
- 但這是 Firebase Auth UID，不是 mesh userId

**問題**：
- 小網狀架構使用 `userId = hash(pubKey)`，不是 Firebase Auth UID
- 需要建立 `Firebase Auth UID` ↔ `Mesh userId` 的對應關係

### 3. Signaling 需求

**需求**：
- 小網狀架構仍需要 WebRTC signaling
- 每個人要連 k=6 個鄰居，每個鄰居需要一個 signaling 通道

**現有方案**：
- ✅ 可以使用 `p2pRooms/{roomId}/signals/{signalId}`
- 但需要支援多個連線（每個鄰居一個）

**問題**：
- 現有 signaling 使用 `from` 和 `to` 欄位
- 小網狀架構需要區分不同的連線（例如：`from-userId` 到 `to-userId`）

## 建議方案

### 方案 1：最小修改（推薦）✅

**優點**：
- 最小化 Firestore 結構變更
- 向後兼容現有系統
- 實作簡單

**修改內容**：

#### 1.1 在 `p2pRooms/{roomId}` 添加可選欄位

```typescript
{
  // ... 現有欄位 ...
  
  // 新增：小網狀架構的身分對應（可選）
  meshIdentities?: {
    [firebaseUid: string]: {
      userId: string; // hash(pubKey)
      pubKey: string; // Base64 編碼的公鑰
      joinedAt: Timestamp;
    };
  };
  
  // 新增：架構類型（用於區分星型拓撲和小網狀）
  topology?: 'star' | 'mesh'; // 預設 'star'
}
```

#### 1.2 Signaling 規則調整

**現有 signaling 規則已經足夠**：
- 使用 `from` 和 `to` 欄位區分不同的連線
- 小網狀架構中，`from` 和 `to` 可以是 `userId`（而不是 Firebase Auth UID）

**或者**：在 signaling 中添加 `connectionId` 欄位
```typescript
{
  from: string; // userId
  to: string; // userId
  connectionId: string; // 唯一連線 ID（例如：`${from}-${to}`）
  type: 'offer' | 'answer' | 'ice';
  payload: any;
  createdAt: Timestamp;
}
```

#### 1.3 Firestore 規則調整

**需要修改的規則**：

```javascript
match /p2pRooms/{roomId} {
  // ... 現有規則 ...
  
  // 更新規則：允許參與者更新 meshIdentities
  allow update: if isAuthenticated() && (
    // 房主可以更新房間
    (request.auth.uid == resource.data.ownerUid) ||
    // 或參與者可以加入（更新 participants）
    (request.auth.uid in request.resource.data.participants && 
     request.auth.uid in resource.data.participants) ||
    // 或參與者可以更新自己的 meshIdentity
    (request.auth.uid in resource.data.participants &&
     request.resource.data.meshIdentities[request.auth.uid].userId != null)
  );
  
  match /signals/{signalId} {
    // 現有規則已經足夠，但可以加強：
    allow read, create: if isAuthenticated() && (
      // 必須是房間參與者
      request.auth.uid in get(/databases/$(database)/documents/p2pRooms/$(roomId)).data.participants
    );
  }
}
```

### 方案 2：新增子集合（更清晰，但更複雜）

**優點**：
- 結構更清晰
- 每個節點的身分資訊獨立

**缺點**：
- 需要更多 Firestore 讀取
- 規則更複雜

**修改內容**：

#### 2.1 新增子集合

```
p2pRooms/{roomId}/meshIdentities/{firebaseUid}
{
  userId: string; // hash(pubKey)
  pubKey: string; // Base64 編碼的公鑰
  joinedAt: Timestamp;
  lastSeen: Timestamp;
}
```

#### 2.2 Firestore 規則

```javascript
match /p2pRooms/{roomId}/meshIdentities/{firebaseUid} {
  // 讀取：房間參與者可以讀取
  allow read: if isAuthenticated() && 
    request.auth.uid in get(/databases/$(database)/documents/p2pRooms/$(roomId)).data.participants;
  
  // 建立/更新：只能更新自己的身分
  allow create, update: if isAuthenticated() && 
    request.auth.uid == firebaseUid &&
    request.auth.uid in get(/databases/$(database)/documents/p2pRooms/$(roomId)).data.participants;
  
  // 刪除：不允許（身分資訊應該保留）
  allow delete: if false;
}
```

### 方案 3：純 P2P（不儲存身分資訊）

**優點**：
- 不需要修改 Firestore 結構
- 完全去中心化

**缺點**：
- 節點發現依賴 `participants` 列表（Firebase Auth UID）
- 需要建立 `Firebase Auth UID` ↔ `Mesh userId` 的對應關係
- 新節點加入時，需要透過 P2P 獲取其他節點的身分資訊

**實作方式**：
- 進入房間時，從 `participants` 列表獲取節點列表
- 透過 P2P 直接請求每個節點的身分資訊（userId + pubKey）
- 不儲存到 Firestore

## 推薦方案：方案 1（最小修改）

### 理由

1. **向後兼容**：現有系統不需要修改
2. **實作簡單**：只需要添加可選欄位
3. **效能好**：身分資訊與房間資料一起讀取
4. **安全性**：可以透過 Firestore 規則控制

### 具體修改

#### Firestore 結構

```typescript
// p2pRooms/{roomId}
{
  // ... 現有欄位 ...
  
  // 新增（可選）
  meshIdentities?: {
    [firebaseUid: string]: {
      userId: string; // hash(pubKey)
      pubKey: string; // Base64 編碼的公鑰
      joinedAt: Timestamp;
    };
  };
  
  topology?: 'star' | 'mesh'; // 預設 'star'
}
```

#### Firestore 規則

```javascript
match /p2pRooms/{roomId} {
  // ... 現有規則 ...
  
  // 更新規則：允許參與者更新自己的 meshIdentity
  allow update: if isAuthenticated() && (
    // 房主可以更新房間
    (request.auth.uid == resource.data.ownerUid) ||
    // 或參與者可以加入（更新 participants）
    (request.auth.uid in request.resource.data.participants && 
     request.auth.uid in resource.data.participants) ||
    // 或參與者可以更新自己的 meshIdentity
    (request.auth.uid in resource.data.participants &&
     request.resource.data.meshIdentities != null &&
     request.resource.data.meshIdentities[request.auth.uid] != null &&
     request.resource.data.meshIdentities[request.auth.uid].userId != null)
  );
  
  match /signals/{signalId} {
    // 現有規則已經足夠
    allow read, create: if isAuthenticated();
    allow update, delete: if false;
  }
}
```

## 實作建議

### 階段 1：添加可選欄位（不破壞現有系統）

1. 在 `P2PRoom` 類型中添加可選欄位
2. 在 `RoomService` 中添加更新 `meshIdentities` 的方法
3. 更新 Firestore 規則（允許參與者更新自己的身分）

### 階段 2：整合到小網狀架構

1. 進入房間時，讀取或更新 `meshIdentities`
2. 從 `meshIdentities` 或 `participants` 獲取節點列表
3. 使用 signaling 建立鄰居連線

### 階段 3：優化（可選）

1. 添加 `topology` 欄位，區分不同架構
2. 根據 `topology` 選擇不同的連線策略

## 總結

### ✅ 需要修改

1. **Firestore 結構**：
   - 在 `p2pRooms/{roomId}` 添加可選欄位 `meshIdentities` 和 `topology`

2. **Firestore 規則**：
   - 更新規則允許參與者更新自己的 `meshIdentity`
   - Signaling 規則已經足夠（可選：加強驗證）

### ❌ 不需要修改

1. **Signaling 結構**：現有結構已經足夠
2. **房間基本結構**：`participants` 列表已經足夠用於節點發現
3. **其他集合**：不需要修改

### 📝 建議

**採用方案 1（最小修改）**：
- 添加可選欄位，不破壞現有系統
- 向後兼容，可以與現有星型拓撲並存
- 實作簡單，風險低
