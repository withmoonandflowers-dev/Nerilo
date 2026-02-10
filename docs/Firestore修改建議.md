# Firestore 修改建議（P2P 小網狀架構）

## 結論

### ✅ 需要小幅修改

1. **Firestore 結構**：添加可選欄位（不破壞現有系統）
2. **Firestore 規則**：允許參與者更新自己的身分資訊

### ❌ 不需要大幅修改

1. **Signaling 結構**：現有結構已經足夠
2. **房間基本結構**：`participants` 列表已經足夠

## 具體修改內容

### 1. TypeScript 類型定義

**檔案**：`src/types/index.ts`

```typescript
// 現有 P2PRoom 類型
export interface P2PRoom {
  roomId: string;
  ownerUid: string;
  ownerName?: string;
  participants: string[];
  status: 'waiting' | 'open' | 'closed';
  isPrivate: boolean;
  createdAt: number;
  waitingTimeout?: number;
  waitingStartedAt?: number;
  
  // 新增：小網狀架構相關（可選）
  meshIdentities?: {
    [firebaseUid: string]: {
      userId: string; // hash(pubKey)
      pubKey: string; // Base64 編碼的公鑰
      joinedAt: number;
    };
  };
  
  topology?: 'star' | 'mesh'; // 預設 'star'
}
```

### 2. Firestore 規則修改

**檔案**：`firestore.rules`

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ... 現有 helper functions ...
    
    // P2P Rooms collection
    match /p2pRooms/{roomId} {
      // 讀取：允許已登入用戶讀取公開房間，或讀取自己參與的房間
      allow read: if isAuthenticated() && (
        !resource.data.isPrivate ||
        request.auth.uid in resource.data.participants ||
        request.auth.uid == resource.data.ownerUid
      );
      
      // 建立：只允許已登入的用戶（非匿名）建立房間
      allow create: if isAuthenticated() && 
        request.auth.token.firebase.sign_in_provider != "anonymous" &&
        request.resource.data.ownerUid == request.auth.uid;
      
      // 更新：允許房主更新房間，或參與者加入/更新自己的身分
      allow update: if isAuthenticated() && (
        // 房主可以更新房間
        (request.auth.uid == resource.data.ownerUid) ||
        // 或參與者可以加入（更新 participants）
        (request.auth.uid in request.resource.data.participants && 
         request.auth.uid in resource.data.participants) ||
        // 或參與者可以更新自己的 meshIdentity（小網狀架構）
        (request.auth.uid in resource.data.participants &&
         request.resource.data.meshIdentities != null &&
         request.resource.data.meshIdentities[request.auth.uid] != null &&
         request.resource.data.meshIdentities[request.auth.uid].userId != null &&
         request.resource.data.meshIdentities[request.auth.uid].pubKey != null)
      );
      
      // 刪除：只允許房主刪除自己的房間
      allow delete: if isAuthenticated() && 
        request.auth.uid == resource.data.ownerUid;

      // Signals subcollection - signaling 訊息
      match /signals/{signalId} {
        // 現有規則已經足夠，但可以加強驗證
        allow read, create: if isAuthenticated() && (
          // 必須是房間參與者
          request.auth.uid in get(/databases/$(database)/documents/p2pRooms/$(roomId)).data.participants
        );
        allow update, delete: if false;
      }
    }
    
    // ... 其他規則 ...
  }
}
```

### 3. RoomService 方法添加

**檔案**：`src/services/RoomService.ts`

```typescript
export class RoomService {
  // ... 現有方法 ...
  
  /**
   * 更新或添加小網狀架構的身分資訊
   */
  static async updateMeshIdentity(
    roomId: string,
    firebaseUid: string,
    userId: string,
    pubKey: string
  ): Promise<void> {
    const roomDoc = doc(db, 'p2pRooms', roomId);
    const roomSnapshot = await getDoc(roomDoc);
    
    if (!roomSnapshot.exists()) {
      throw new Error('房間不存在');
    }
    
    const roomData = roomSnapshot.data();
    const participants = roomData.participants || [];
    
    if (!participants.includes(firebaseUid)) {
      throw new Error('用戶不是房間參與者');
    }
    
    // 更新 meshIdentities
    const meshIdentities = roomData.meshIdentities || {};
    meshIdentities[firebaseUid] = {
      userId,
      pubKey,
      joinedAt: Timestamp.fromMillis(Date.now()),
    };
    
    await updateDoc(roomDoc, {
      meshIdentities,
    });
    
    if (DEBUG_ROOMS) {
      console.log('[RoomService] Updated mesh identity', {
        roomId,
        firebaseUid,
        userId,
      });
    }
  }
  
  /**
   * 獲取房間內所有節點的 mesh 身分資訊
   */
  static async getMeshIdentities(roomId: string): Promise<Map<string, { userId: string; pubKey: string }>> {
    const room = await this.getRoom(roomId);
    if (!room || !room.meshIdentities) {
      return new Map();
    }
    
    const identities = new Map<string, { userId: string; pubKey: string }>();
    for (const [firebaseUid, identity] of Object.entries(room.meshIdentities)) {
      identities.set(firebaseUid, {
        userId: identity.userId,
        pubKey: identity.pubKey,
      });
    }
    
    return identities;
  }
}
```

## 使用方式

### 進入房間時註冊身分

```typescript
// 在 MeshGossipManager 初始化時
async initialize(): Promise<void> {
  // 1. 建立身分
  await this.identityManager.initialize();
  const userId = this.identityManager.getUserId();
  const pubKey = await this.identityManager.exportPublicKey();
  
  // 2. 註冊到 Firestore
  const firebaseUid = auth.currentUser?.uid;
  if (firebaseUid) {
    await RoomService.updateMeshIdentity(
      this.roomId,
      firebaseUid,
      userId,
      pubKey
    );
  }
  
  // 3. 獲取其他節點的身分資訊
  const identities = await RoomService.getMeshIdentities(this.roomId);
  
  // 4. 建立鄰居連線
  // ...
}
```

### 節點發現

```typescript
// 從 Firestore 獲取節點列表
const room = await RoomService.getRoom(roomId);
const participants = room.participants; // Firebase Auth UID 列表

// 獲取 mesh 身分資訊
const identities = await RoomService.getMeshIdentities(roomId);

// 建立對應關係
const nodeMap = new Map<string, string>(); // firebaseUid -> userId
for (const firebaseUid of participants) {
  const identity = identities.get(firebaseUid);
  if (identity) {
    nodeMap.set(firebaseUid, identity.userId);
  }
}
```

## 向後兼容性

### ✅ 完全向後兼容

1. **現有系統**：
   - `meshIdentities` 和 `topology` 是可選欄位
   - 現有星型拓撲系統不受影響

2. **現有規則**：
   - 新規則只是擴展，不影響現有功能
   - 現有 signaling 規則仍然有效

3. **現有資料**：
   - 舊房間沒有 `meshIdentities` 欄位，不影響運作
   - 新房間可以選擇使用星型或小網狀拓撲

## 總結

### 修改清單

1. ✅ **TypeScript 類型**：添加可選欄位
2. ✅ **Firestore 規則**：允許參與者更新自己的身分
3. ✅ **RoomService**：添加更新和獲取身分的方法

### 不需要修改

1. ❌ **Signaling 結構**：現有結構已經足夠
2. ❌ **房間基本結構**：`participants` 列表已經足夠
3. ❌ **其他集合**：不需要修改

### 建議

**採用最小修改方案**：
- 添加可選欄位，不破壞現有系統
- 向後兼容，可以與現有星型拓撲並存
- 實作簡單，風險低
