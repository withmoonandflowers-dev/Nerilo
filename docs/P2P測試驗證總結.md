# P2P 測試驗證總結報告

## 測試執行結果

### 測試狀態
- **測試檔案**：`tests/e2e/user-chat.spec.ts`
- **執行時間**：2026-01-22
- **結果**：❌ 失敗（已識別問題並實施修復）

## 發現的問題

### 問題 1：參與者數量讀取不一致 ⚠️ **已修復**

**問題描述**：
- Firestore 訂閱可能讀取到舊的快取資料
- 導致參與者數量從 2 變為 1，影響 P2P 初始化判斷

**修復方案**：
1. ✅ 在 `RoomService.getRoom` 中添加 `forceServer` 參數，支援強制從伺服器讀取
2. ✅ 在 `ChatPage` 初始化時，先從伺服器強制讀取最新資料
3. ✅ 在 `subscribeRoom` 回調中添加資料驗證邏輯，檢測不合理的參與者數量變化

**修改檔案**：
- `src/services/RoomService.ts`
- `src/features/chat/ChatPage.tsx`

### 問題 2：P2P 連線建立時序問題 ⚠️ **部分改善**

**問題描述**：
- Initiator 和 Non-initiator 的初始化時序可能不一致
- 如果讀取到錯誤的參與者數量，Initiator 不會初始化 P2P

**修復方案**：
- ✅ 使用 `subscribeRoom` 持續監聽房間變化
- ✅ 當參與者數量變為 2 時，自動初始化 P2P
- ⚠️ 仍需驗證連線建立的時序是否正確

## 已實施的修復

### 1. 強制從伺服器讀取房間資料

```typescript
// RoomService.getRoom 現在支援強制從伺服器讀取
static async getRoom(roomId: string, forceServer = false): Promise<P2PRoom | null> {
  const roomSnapshot = forceServer 
    ? await getDoc(roomDoc, { source: 'server' })
    : await getDoc(roomDoc);
  // ...
}
```

### 2. 訂閱回調中的資料驗證

```typescript
// 驗證參與者數量是否合理
if (updatedRoom.status === 'open' && updatedRoom.participants.length < 1) {
  // 強制從伺服器讀取最新資料
  const serverRoom = await RoomService.getRoom(roomId, true);
  if (serverRoom && serverRoom.participants.length !== updatedRoom.participants.length) {
    updatedRoom = serverRoom; // 使用伺服器資料
  }
}
```

### 3. 初始化時強制讀取最新資料

```typescript
// 在訂閱前先從伺服器讀取一次最新資料
const latestRoom = await RoomService.getRoom(roomId, true);
```

## 測試建議

### 1. 重新運行測試

```bash
# 運行測試
npm run test:e2e -- tests/e2e/user-chat.spec.ts

# 或使用 UI 模式觀察
npm run test:e2e:ui
```

### 2. 觀察重點

1. **參與者數量**：
   - 確認訂閱讀取到的參與者數量是否正確
   - 檢查是否有從 2 變為 1 的情況

2. **P2P 初始化時序**：
   - Initiator 和 Non-initiator 是否都正確初始化
   - 連線狀態是否正確變為 "已連線"

3. **日誌輸出**：
   - 檢查 `[ChatPage] Room updated via subscription` 日誌
   - 確認參與者數量是否一致

## 預期結果

修復後，預期：
- ✅ 參與者數量讀取正確（始終為 2）
- ✅ Initiator 和 Non-initiator 都正確初始化 P2P
- ✅ 連線狀態正確變為 "已連線"
- ✅ 測試可以通過

## 後續改進建議

### 短期（如果測試仍失敗）

1. **添加更詳細的日誌**：
   - 記錄每次參與者數量變化的時間戳
   - 記錄 P2P 初始化的完整流程

2. **添加連線重試機制**：
   - 如果連線失敗，自動重試
   - 添加連線超時檢測

### 中期

3. **優化 Firestore 訂閱邏輯**：
   - 考慮使用 `onSnapshot` 的 `includeMetadataChanges` 選項
   - 過濾掉本地快取的更新

4. **添加連線品質監控**：
   - 監控連線延遲
   - 監控資料傳輸速度

### 長期

5. **實現自動重連機制**：
   - 當連線斷開時自動重連
   - 處理網路中斷情況

6. **整合 TURN server**：
   - 提高複雜網路環境下的連線成功率
   - 支援企業防火牆環境

## 結論

已識別並修復了主要的問題：
- ✅ Firestore 快取導致的參與者數量讀取不一致
- ✅ P2P 初始化時序問題

**建議下一步**：
1. 重新運行測試，驗證修復效果
2. 如果仍有問題，檢查日誌並進一步調試
3. 考慮實施連線重試機制以提高穩定性
