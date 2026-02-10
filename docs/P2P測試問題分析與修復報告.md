# P2P 測試問題分析與修復報告

## 測試結果

### 測試執行
- **測試檔案**：`tests/e2e/user-chat.spec.ts`
- **測試狀態**：❌ 失敗
- **失敗原因**：無法建立 P2P 連線（連線狀態未達到「已連線」）

## 問題分析

### 問題 1：參與者數量讀取不一致 ⚠️

**現象**：
- 使用者 B 加入房間時，房間狀態變為 `open`，參與者數量為 2
- 使用者 A 進入 ChatPage 時，初始讀取到的參與者數量是 2（正確）
- 但 `subscribeRoom` 訂閱觸發時，讀取到的參與者數量卻是 1（錯誤）

**日誌證據**：
```
[A] log [ChatPage] Room found {status: open, participants: 2}  // ✅ 正確
[A] log [ChatPage] Room updated via subscription {participants: 1}  // ❌ 錯誤
```

**根本原因**：
1. Firestore 的快取或同步延遲問題
2. `RoomService.joinRoom` 在 `isNewParticipant: false` 時不更新房間資料，但可能觸發了訂閱
3. 訂閱可能讀取到舊的快取資料

### 問題 2：P2P 連線未建立 ❌

**現象**：
- 使用者 B（non-initiator）正確初始化了 P2P Manager
- 使用者 A（initiator）因為讀取到參與者數量為 1，所以不初始化 P2P
- 結果：雙方無法建立連線

**日誌證據**：
```
[B] log [P2PManager] Waiting for remote DataChannel as non-initiator  // ✅ B 等待中
[A] log [ChatPage] Only one participant, waiting for others to join  // ❌ A 認為只有1人
```

## 已實施的修復

### 修復 1：使用 `subscribeRoom` 監聽房間變化

**修改檔案**：`src/features/chat/ChatPage.tsx`

**變更內容**：
- 將原本的一次性讀取改為使用 `subscribeRoom` 持續監聽
- 當房間狀態或參與者數量變化時，自動重新檢查並初始化 P2P

**預期效果**：
- 確保讀取到最新的房間資料
- 當參與者數量變為 2 時，自動初始化 P2P

**實際效果**：
- ⚠️ 部分改善，但仍存在參與者數量讀取不一致的問題

## 剩餘問題

### 問題 1：Firestore 訂閱讀取到舊資料

**可能原因**：
1. Firestore 本地快取未及時更新
2. `joinRoom` 的更新邏輯有問題
3. 訂閱觸發時機問題

**建議修復方案**：

#### 方案 A：強制從伺服器讀取（推薦）

在 `RoomService.getRoom` 中添加 `source: 'server'` 選項：

```typescript
static async getRoom(roomId: string): Promise<P2PRoom | null> {
  const roomDoc = doc(db, 'p2pRooms', roomId);
  const room = await getDoc(roomDoc, { source: 'server' }); // 強制從伺服器讀取
  // ...
}
```

#### 方案 B：在 `subscribeRoom` 中過濾舊資料

在訂閱回調中，比較時間戳，忽略舊的更新：

```typescript
let lastUpdateTime = 0;
unsubscribeRoomRef.current = RoomService.subscribeRoom(roomId, async (updatedRoom) => {
  const currentTime = Date.now();
  if (currentTime < lastUpdateTime + 1000) {
    // 忽略1秒內的舊更新
    return;
  }
  lastUpdateTime = currentTime;
  // ...
});
```

#### 方案 C：修復 `joinRoom` 邏輯

確保 `joinRoom` 即使 `isNewParticipant: false` 時也觸發訂閱更新：

```typescript
// 在 RoomService.joinRoom 中
if (isNewParticipant || shouldActivate) {
  // 更新房間資料
} else {
  // 即使不更新，也觸發一次讀取以確保訂閱收到最新資料
  await getDoc(roomDoc); // 觸發訂閱更新
}
```

### 問題 2：P2P 連線建立時序問題

**問題描述**：
- Initiator 和 Non-initiator 的初始化時序可能不一致
- 如果 Non-initiator 先初始化，Initiator 後初始化，可能導致連線失敗

**建議修復方案**：

#### 方案 A：添加重試機制

在 P2PConnectionManager 中添加連線重試邏輯：

```typescript
private async retryConnection(maxRetries = 3): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await this.createOffer();
      return;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}
```

#### 方案 B：添加連線超時檢測

檢測連線建立時間，如果超過一定時間未建立，重新初始化：

```typescript
const connectionTimeout = setTimeout(() => {
  if (connectionState !== 'connected') {
    console.warn('Connection timeout, reinitializing...');
    // 重新初始化 P2P
  }
}, 30000); // 30秒超時
```

## 建議的修復優先順序

### 高優先級（立即修復）

1. **修復 Firestore 訂閱讀取問題**
   - 實施方案 A：強制從伺服器讀取
   - 或實施方案 C：修復 `joinRoom` 邏輯

2. **添加連線狀態日誌**
   - 在 P2PConnectionManager 中添加更詳細的日誌
   - 追蹤連線建立的每個步驟

### 中優先級（短期改進）

3. **添加連線重試機制**
   - 實施方案 A：添加重試邏輯

4. **優化訂閱邏輯**
   - 實施方案 B：過濾舊資料

### 低優先級（長期優化）

5. **添加連線品質監控**
   - 監控連線延遲、頻寬等指標

6. **實現自動重連機制**
   - 當連線斷開時自動重連

## 測試建議

### 1. 本地測試

```bash
# 運行測試
npm run test:e2e:ui

# 觀察日誌
# 特別注意：
# - 參與者數量的變化
# - P2P 初始化的時序
# - 連線狀態的變化
```

### 2. 手動測試

1. 開啟兩個瀏覽器視窗
2. 建立房間並加入
3. 檢查瀏覽器 Console 的日誌
4. 確認連線狀態是否正確

### 3. 添加調試日誌

在關鍵位置添加更詳細的日誌：

```typescript
console.log('[ChatPage] Room subscription update', {
  roomId,
  participants: updatedRoom.participants,
  participantCount: updatedRoom.participants.length,
  timestamp: Date.now(),
});
```

## 結論

目前的主要問題是 **Firestore 訂閱讀取到舊的參與者數量**，導致 P2P 連線無法正確建立。

**建議立即實施**：
1. 修復 `RoomService.getRoom` 使用 `source: 'server'` 強制從伺服器讀取
2. 或在 `subscribeRoom` 回調中添加資料驗證邏輯

**預期效果**：
- 確保讀取到最新的參與者數量
- P2P 連線可以正確建立
- 測試可以通過
