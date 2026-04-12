# Nerilo P2P 即時聊天平台 — 程式碼深度審查

## 你的角色
你是一位有 10+ 年經驗的資深前端/全端工程師，專精 React、TypeScript、
WebRTC、Firebase。請對 Nerilo 的程式碼品質、效能、可維護性做深度審查。

## 專案概況
- **Repo**: https://github.com/withmoonandflowers-dev/Nerilo
- **Branch**: feature/multi-room-improvements
- **技術棧**: React 18 + TypeScript 5 + Vite 5 + Firebase Auth/RTDB + WebRTC
- **重要背景**: 最近從 Firestore 遷移到 Firebase RTDB，可能有殘留問題

## 審查範圍

### A. 遷移完整性（最高優先）
專案最近從 Firestore 遷移到 Firebase RTDB，請徹底檢查：
1. `grep -rn "firebase/firestore" src/ functions/` — 是否有殘留的 Firestore import？
2. `grep -rn "p2pRooms" src/` — 是否有殘留的舊 collection path？
3. `grep -rn "Timestamp\." src/` — 是否有殘留的 Firestore Timestamp 使用？
4. `grep -rn "\.data()" src/` — 是否有殘留的 Firestore snapshot.data()（RTDB 用 .val()）？
5. 所有 `onSnapshot` 是否都改為 `onValue` 或 `onChildAdded`？
6. 所有 `runTransaction(db, fn)` 是否改為 RTDB 的 `runTransaction(ref, fn)`？
7. `participants` 格式：前端用 `string[]`，RTDB 存 `{uid: true}`，所有轉換點是否正確？

### B. React 效能問題
1. **不必要的 re-render**：
   - `ChatPage.tsx` 的 useEffect 依賴陣列是否正確？
   - `useChatMessages` hook 是否在每次 render 時建立新的 callback？
   - 是否有 `useCallback`/`useMemo` 缺失導致的 child re-render？
2. **記憶體洩漏**：
   - 所有 `onValue`/`onChildAdded` 訂閱是否在 cleanup 中取消？
   - `P2PConnectionManager` 的 event listener 是否在 close() 時全部移除？
   - `setInterval`/`setTimeout` 是否在 unmount 時清除？
3. **狀態管理**：
   - AuthContext、ServicesContext 的 re-render 是否影響整棵 component tree？
   - 是否應該用 `useSyncExternalStore` 或 state splitting 優化？

### C. WebRTC 連線管理
檢查 `src/core/p2p/`：
1. `P2PConnectionManager.close()` 是否會留下 orphan connections？
2. ICE gathering 是否有 timeout 機制（防止無限等待 candidates）？
3. DataChannel 的 bufferedAmount 是否有背壓機制？
4. 多人房間中 N*(N-1)/2 連線的 scalability — 在 10 人時是否已經不堪負荷？

### D. 錯誤處理
1. RTDB `get()`/`set()`/`update()` 的 error handling 是否完整？
2. 網路斷線時的 graceful degradation 是否正確？
3. Firebase Auth token 過期時是否有自動 refresh？
4. Promise rejection 是否都被 catch（避免 unhandled promise rejection）？

### E. TypeScript 品質
1. `any` 使用是否合理？是否能用更精確的型別？
2. Type assertion（`as`）是否隱藏了 runtime 錯誤？
3. Discriminated union 是否應用在 ConnectionState、RoomStatus 等？
4. 泛型是否被充分利用（特別是 RTDB snapshot 的型別安全）？

### F. 安全性
1. RTDB security rules 是否有過度開放的路徑？
2. 用戶輸入（聊天訊息）是否有 XSS sanitization？
3. Room ID 是否可被猜測（UUID v4 是否足夠隨機）？
4. Signal payload 是否有大小限制防止 abuse？

## 輸出格式
每個發現：
```
### [嚴重度] 問題標題
- **檔案**: path/to/file.ts:行號
- **問題**: 具體描述
- **影響**: 會導致什麼
- **修復**: 具體程式碼修改建議
```

最後提供 **Tech Debt 清單**，按影響排序。
