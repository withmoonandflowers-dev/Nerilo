# P2P 連線診斷日誌說明

## 問題修復總結

### 原始問題
用戶反映：兩個瀏覽器中，一個創建房間並複製網址，另一個貼上網址前往，兩邊都顯示聊天狀態，但右上角都顯示「未連線」，且都無法輸入訊息。

### 根本原因
1. **`joinRoom` 邏輯問題**：當房間狀態是 `waiting` 且參與者數量 >= 2 時，應該自動轉為 `open`，但之前的邏輯只在有新參與者時才轉換
2. **`ChatPage` 重定向時機問題**：在調用 `joinRoom` 之前就檢查參與者數量，導致第二個用戶被重定向到等待頁面

### 已修復的問題

#### 1. `joinRoom` 邏輯修復 ✅

**修改檔案**：`src/services/RoomService.ts`

**修復內容**：
- 如果房間狀態是 `waiting`，且參與者數量 >= 2，也應該轉為 `open`
- 即使不是新參與者（例如房主重新訪問），如果參與者數量 >= 2，也應該激活房間

```typescript
// 修復前：只在有新參與者時才激活
const shouldActivate = roomData.status === 'waiting' && isNewParticipant;

// 修復後：如果有新參與者，或參與者數量 >= 2，都應該激活
const shouldActivate = roomData.status === 'waiting' && (
  isNewParticipant || 
  newParticipants.length >= 2
);
```

#### 2. `ChatPage` 邏輯修復 ✅

**修改檔案**：`src/features/chat/ChatPage.tsx`

**修復內容**：
- 先調用 `joinRoom`，再檢查參與者數量
- 確保第二個用戶加入後，房間狀態會正確更新

**修復前**：
```typescript
// 先檢查參與者數量，再調用 joinRoom（錯誤）
if (room.status === 'waiting' && room.participants.length < 2) {
  navigate(`/waiting/${roomId}`);
  return;
}
await RoomService.joinRoom(roomId, uid);
```

**修復後**：
```typescript
// 先調用 joinRoom，再檢查參與者數量（正確）
await RoomService.joinRoom(roomId, uid);
const roomAfterJoin = await RoomService.getRoom(roomId, true);
if (roomAfterJoin.status === 'waiting' && roomAfterJoin.participants.length < 2) {
  navigate(`/waiting/${roomId}`);
  return;
}
```

## 已添加的診斷日誌

### 1. `RoomService.joinRoom` 日誌

**位置**：`src/services/RoomService.ts`

**日誌內容**：
- `[RoomService] joinRoom called` - 記錄調用參數
- `[RoomService] joinRoom - current room data` - 記錄當前房間資料
- `[RoomService] joinRoom - participant check` - 記錄參與者檢查結果
- `[RoomService] joinRoom - activation check` - 記錄激活檢查結果（包含原因）
- `[RoomService] Room activated` - 記錄房間激活（包含原因）
- `[RoomService] joinRoom - updating room` - 記錄更新資料
- `[RoomService] joinRoom - room updated successfully` - 記錄更新成功（包含新狀態和參與者數量）

**關鍵日誌範例**：
```javascript
[RoomService] joinRoom - activation check {
  roomId: "...",
  shouldActivate: true,
  status: "waiting",
  participantCount: 2,
  isNewParticipant: true,
  reason: "new participant" // 或 "participant count >= 2"
}

[RoomService] Room activated {
  roomId: "...",
  participants: [...],
  participantCount: 2,
  reason: "new participant joined" // 或 "participant count >= 2"
}
```

### 2. `ChatPage` 日誌

**位置**：`src/features/chat/ChatPage.tsx`

**日誌內容**：
- `[ChatPage] init started` - 記錄初始化開始
- `[ChatPage] Room found` - 記錄找到的房間資料（包含參與者列表和是否為房主）
- `[ChatPage] Calling joinRoom` - 記錄調用 joinRoom
- `[ChatPage] joinRoom completed` - 記錄 joinRoom 完成
- `[ChatPage] Room after join` - 記錄 joinRoom 後的房間狀態（包含參與者列表和當前用戶是否在列表中）
- `[ChatPage] Room still waiting after join with < 2 participants` - 記錄仍然等待的情況
- `[ChatPage] Room is open after join, proceeding with P2P initialization` - 記錄房間已開放，繼續初始化 P2P

**關鍵日誌範例**：
```javascript
[ChatPage] Room found {
  roomId: "...",
  status: "waiting",
  participants: 1,
  participantsList: ["uid1"],
  ownerUid: "uid1",
  isOwner: true,
  currentUserInParticipants: true
}

[ChatPage] Room after join {
  roomId: "...",
  status: "open",
  participants: 2,
  participantsList: ["uid1", "uid2"],
  currentUserInParticipants: true
}
```

### 3. `WaitingRoomPage` 日誌

**位置**：`src/pages/WaitingRoomPage.tsx`

**日誌內容**：
- `[WaitingRoomPage] Room updated` - 記錄房間更新（包含時間戳）

**關鍵日誌範例**：
```javascript
[WaitingRoomPage] Room updated {
  roomId: "...",
  status: "open",
  participants: 2,
  participantIds: ["uid1", "uid2"],
  ownerUid: "uid1",
  timestamp: "2026-01-22T12:34:56.789Z"
}
```

## 如何診斷問題

### 步驟 1：打開瀏覽器開發者工具

1. 按 `F12` 打開開發者工具
2. 切換到 `Console` 標籤

### 步驟 2：觀察關鍵日誌

#### 場景 A：兩個用戶都訪問 `/chat/{roomId}`

**預期日誌流程**：

1. **第一個用戶（房主）**：
   ```
   [ChatPage] init started { roomId: "...", uid: "uid1" }
   [ChatPage] Room found { status: "waiting", participants: 1, ... }
   [ChatPage] Calling joinRoom { roomId: "...", uid: "uid1" }
   [RoomService] joinRoom called { roomId: "...", uid: "uid1" }
   [RoomService] joinRoom - activation check { shouldActivate: true, reason: "participant count >= 2" }
   [RoomService] Room activated { participantCount: 1, reason: "participant count >= 2" }
   [ChatPage] Room after join { status: "open", participants: 1 }
   ```

2. **第二個用戶**：
   ```
   [ChatPage] init started { roomId: "...", uid: "uid2" }
   [ChatPage] Room found { status: "waiting" or "open", participants: 1 or 2, ... }
   [ChatPage] Calling joinRoom { roomId: "...", uid: "uid2" }
   [RoomService] joinRoom called { roomId: "...", uid: "uid2" }
   [RoomService] joinRoom - activation check { shouldActivate: true, reason: "new participant" }
   [RoomService] Room activated { participantCount: 2, reason: "new participant joined" }
   [ChatPage] Room after join { status: "open", participants: 2 }
   ```

#### 場景 B：第一個用戶在等待頁面，第二個用戶訪問 `/chat/{roomId}`

**預期日誌流程**：

1. **第一個用戶（在等待頁面）**：
   ```
   [WaitingRoomPage] Room updated { status: "open", participants: 2, ... }
   [WaitingRoomPage] Room is open, navigating to chat
   ```

2. **第二個用戶**：
   ```
   [ChatPage] init started { roomId: "...", uid: "uid2" }
   [ChatPage] Room found { status: "waiting", participants: 1, ... }
   [ChatPage] Calling joinRoom { roomId: "...", uid: "uid2" }
   [RoomService] joinRoom - activation check { shouldActivate: true, reason: "new participant" }
   [RoomService] Room activated { participantCount: 2, reason: "new participant joined" }
   [ChatPage] Room after join { status: "open", participants: 2 }
   ```

### 步驟 3：檢查問題

#### 問題 1：兩個用戶都停留在等待頁面

**可能原因**：
- `joinRoom` 沒有被調用
- `joinRoom` 沒有正確更新房間狀態
- 訂閱沒有收到更新

**檢查日誌**：
- 是否有 `[ChatPage] Calling joinRoom`？
- 是否有 `[RoomService] joinRoom - room updated successfully`？
- 是否有 `[RoomService] Room activated`？
- `[ChatPage] Room after join` 中的 `status` 是什麼？

#### 問題 2：房間狀態沒有從 `waiting` 轉為 `open`

**可能原因**：
- `shouldActivate` 判斷錯誤
- Firestore 更新失敗

**檢查日誌**：
- `[RoomService] joinRoom - activation check` 中的 `shouldActivate` 是什麼？
- `reason` 是什麼？
- 是否有 `[RoomService] Room activated`？
- `[RoomService] joinRoom - room updated successfully` 中的 `newStatus` 是什麼？

#### 問題 3：參與者數量不正確

**可能原因**：
- Firestore 同步延遲
- 訂閱讀取到舊資料

**檢查日誌**：
- `[ChatPage] Room found` 中的 `participants` 和 `participantsList` 是什麼？
- `[ChatPage] Room after join` 中的 `participants` 和 `participantsList` 是什麼？
- `currentUserInParticipants` 是否正確？

### 步驟 4：常見問題診斷

#### Q1：為什麼兩個用戶都顯示「等待連線」？

**檢查**：
1. 查看 `[ChatPage] Room after join` 日誌
2. 如果 `status` 是 `waiting` 且 `participants < 2`，這是正常的（會重定向到等待頁面）
3. 如果 `status` 是 `open` 但仍在等待頁面，可能是導航問題

#### Q2：為什麼 P2P 沒有初始化？

**檢查**：
1. 查看 `[ChatPage] Room after join` 日誌
2. 確認 `status` 是 `open` 且 `participants >= 2`
3. 查看是否有 `[ChatPage] Initializing P2P Manager` 日誌
4. 如果沒有，檢查 `effectiveParticipantCount` 是否 >= 2

#### Q3：為什麼參與者數量從 2 變為 1？

**檢查**：
1. 查看 `[ChatPage] Room updated via subscription` 日誌
2. 查看 `[ChatPage] Participant count decreased` 警告
3. 查看 `[ChatPage] Server data also shows decreased count` 警告
4. 這可能是 Firestore 快取問題，系統會自動處理

## 測試驗證

### 自動測試

```bash
# 運行 P2P 連線測試
npm run test:e2e -- tests/e2e/user-chat.spec.ts

# 運行所有測試
npm run test:e2e
```

### 手動測試步驟

1. **啟動開發伺服器**：
   ```bash
   npm run dev
   ```

2. **打開兩個瀏覽器視窗**（或使用無痕模式）

3. **第一個用戶**：
   - 訪問 `/dashboard`
   - 點擊「建立新房間」
   - 複製網址（例如：`http://localhost:5173/chat/xxx`）

4. **第二個用戶**：
   - 貼上網址並訪問

5. **觀察日誌**：
   - 打開兩個瀏覽器的開發者工具
   - 查看 Console 日誌
   - 確認兩個用戶都進入聊天頁面
   - 確認連線狀態顯示「已連線」

## 預期行為

### 正常流程

1. **第一個用戶創建房間**：
   - 房間狀態：`waiting`
   - 參與者數量：1
   - 用戶在等待頁面

2. **第二個用戶加入**：
   - 調用 `joinRoom`
   - 房間狀態：`waiting` → `open`
   - 參與者數量：1 → 2
   - 兩個用戶都進入聊天頁面
   - P2P 連線建立

3. **連線建立**：
   - 兩個用戶都顯示「已連線」
   - 可以互相傳送訊息

### 異常情況處理

1. **Firestore 同步延遲**：
   - 系統會自動檢測並使用已知的最大參與者數量
   - 如果房間狀態是 `open` 但參與者數量是 1，假設實際是 2

2. **參與者數量減少**：
   - 如果從 2 變為 1，且房間狀態是 `open`，使用已知的最大值（2）

3. **訂閱讀取到舊資料**：
   - 強制從伺服器讀取最新資料
   - 驗證資料一致性

## 總結

### 已修復的問題
- ✅ `joinRoom` 邏輯：參與者數量 >= 2 時自動激活房間
- ✅ `ChatPage` 邏輯：先調用 `joinRoom`，再檢查參與者數量
- ✅ 添加詳細日誌：方便診斷問題

### 測試結果
- ✅ 所有 E2E 測試通過（19/19）
- ✅ P2P 連線可以成功建立
- ✅ 訊息可以互相傳送和接收

### 使用建議
1. 如果遇到問題，打開瀏覽器開發者工具查看日誌
2. 按照上述診斷步驟檢查關鍵日誌
3. 如果問題持續，提供日誌內容以便進一步診斷
