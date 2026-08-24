# Spec 026：讓嵌入者傳大型二進位（資產/回放檔）

- 軌別：feature
- 狀態：done（2026-08-24 同日完成，V1-V5 驗收過）
- 建立：2026-08-24／最後更新：2026-08-24
- 關聯：Spec 023（raw 通道）、Spec 025（保留 label 先例）、2026-08-24 資料類型盤點（六類之五，最後一塊）

## 1. 要做什麼、為什麼（specify）

資料類型盤點六類中唯一還缺的：大型二進位（遊戲資產、回放檔、圖片、存檔）。現況是嵌入者要自己刻分塊、流控、完整性驗證——SDK 內確實有一份檔案傳輸實作（`P2PFileTransferService`），但它綁在 React star 產線的 ChannelBus 上、不在 SDK 表面，且無加密整合。

要補：**點對點檔案傳輸**——offer/accept 語義（收方同意才收）、分塊、進度、完整性驗證（SHA-256）、取消，全數走 raw 通道房金鑰密封管線。補完後六類資料全部有對應 API，「按資料類型選通道」的表格不再有缺口列。

**憲法檢核**（constitution.md）：
- 目標函數加分項：**可嵌入**（六類盤點的最後缺口）；可維運（取代嵌入者各自亂刻的分塊協議）。
- 四條不變量影響：恰好一次〈無影響：走可靠 raw 通道（連線存續期間保序不丟），完整性由端到端 SHA-256 驗證兜底〉；E2EE〈**有**：每個 chunk 經 raw 密封管線（房金鑰），不開新明文面〉；帳本正當性〈無影響〉；身分授權〈無影響：傳輸對象＝mesh 房間成員〉。

## 2. 邊界（明確不做）

- 不做斷線續傳：可靠性只及連線存續期間，斷線＝傳輸失敗（fail-visible），重傳由嵌入者重呼叫。
- 不做磁碟串流：組裝在記憶體（Uint8Array），預設上限 64MB（可調）；更大的檔案不是 P2P 房間該搬的東西。
- 不做廣播傳輸：一次一個對象（要發給全房自己迴圈）。
- 不做傳輸市場/信使寄存整合（離線收檔走不通：檔案遠超信使 4KB 上限，本 spec 限在線雙方）。
- 不動既有 `P2PFileTransferService`（React 產線退役時一併處理，本 spec 不接不刪）。

## 3. 待釐清（clarify，2026-08-24；技術判斷由提案者決定並記錄，延續 024/025 慣例）

- [x] **Q1 流控**：ack 視窗制（收方每收滿一批回 ack，送方 in-flight 上限一個視窗）。理由：`RawChannel` 刻意不暴露 bufferedAmount（表面最小化）；ack 視窗在應用層自足、且天然適配密封鏈的節奏。預設 chunk 16KB（跨瀏覽器安全值）× 視窗 32 ＝ 512KB in-flight。
- [x] **Q2 收方同意**：offer/accept 制。收方不註冊 handler 或明示拒絕 → 送方收 reject。理由：無同意制＝任何房間成員可塞爆你的記憶體（64MB 級），這是安全面不是體驗面。
- [x] **Q3 完整性**：端到端 SHA-256（offer 帶雜湊，收方組裝後驗證，不符＝失敗）。GCM 保單 chunk 完整性，SHA-256 保「整份檔案」與「送方宣稱」一致。
- [x] **Q4 通道**：每筆傳輸開專用 raw 通道 `file`（保留 label，比照 `state` 先例），`{ordered:true}` 可靠模式；控制訊息（offer/ack/done）與 chunk 同通道（保序故安全）。傳完即關。

## 4. 技術計畫（plan）

### 4.1 契約（`nerilo/transport` 增）

```
NeriloTransportClient 增：
  sendFile(peerId, data: Uint8Array, meta?: { name?, mime? }): FileSend
  onFileOffer(cb: (offer: FileOffer) => void): () => void   // 未註冊＝一律 reject

FileOffer {
  peerId, name?, mime?, size
  accept(): FileReceive
  reject(reason?): void
}
FileSend {
  onProgress(cb: (sent: number, total: number) => void): () => void
  done: Promise<void>          // resolve＝對方驗證通過；reject＝拒收/取消/斷線/驗證失敗
  cancel(): void
}
FileReceive {
  onProgress(cb: (got: number, total: number) => void): () => void
  done: Promise<{ data: Uint8Array, name?, mime? }>
  cancel(): void
}
```

### 4.2 線上協議（label `file` 專用通道，可靠保序）

- 控制訊息（JSON 字串）：`{t:'o', id, name?, mime?, size, chunk, sha}`（offer）／`{t:'a', id}`／
  `{t:'r', id, reason?}`／`{t:'k', id, upTo}`（ack）／`{t:'d', id, ok}`（收方驗證結果）／`{t:'c', id}`（取消）。
- 資料 chunk（二進位）：`[id: uint32][seq: uint32][bytes]`（同通道保序，故 seq 僅作防禦性驗證）。
- 送方：offer → 等 accept → 送 chunk（in-flight ≤ 視窗，收 ack 前進）→ 送畢等 `d`。
- 收方：accept 後收 chunk 組裝 → 收滿 size → SHA-256 比對 → 回 `d`。
- 任一端 `c` 或通道關閉 → 兩側 done reject（fail-visible）。

### 4.3 取捨

- 專用通道傳完即關（非常駐）：檔案傳輸是偶發大流量，不佔常駐資源；開通道成本（SCTP 加流）毫秒級。
- 記憶體組裝上限 64MB：與「快照一則內送完」同一哲學——超過的場景（影片、大資產包）應走 CDN/自有後端，P2P 房間傳輸不是對的工具，文件直說。
- SHA-256 用 SubtleCrypto digest（環境本來就要求 SubtleCrypto，零新依賴）。

〔實作期修訂（實測揪出，回饋到 Spec 023 的 RawChannel 語義）〕
① `RawChannel.close()` 改 **flush-then-close**：控制訊息（拒收/完成/取消）走非同步密封鏈，
同步關通道會把「最後一句話」關在門裡，對端只看得到「連線中斷」。
② **入站解密序列化**：原實作併發解密，ordered 通道的到達順序可能被非同步解密重排
（潛在缺陷，本 spec 實測前未現形）；close 事件也排在入站鏈之後。
③ `cancel()` 在握手完成前改旗標制（原為 no-op，早取消會被吞掉）。

## 5. 任務分解（tasks）

- [x] T1：chunk 編解碼純函式＋sha256Hex（fileTransfer.ts 頂部），單元覆蓋。
- [x] T2：協議實作（FileTransferManager；含實作期修訂三則）。
- [x] T3：transport client 接線（file 分流＋lazy manager）；fitness 快照 +3 匯出。
- [x] T4：契約測試 6 例（1MB 往返雜湊/進度單調/明示拒絕/取消/無 handler 自動拒收/超限拋錯）。
- [x] T5：examples/file-transfer 驗證頁（port 5183，launch: nerilo-file-transfer）。
- [x] T6：資料類型表第 5 列轉正＋類 5 範例與誠實邊界；CHANGELOG（含 RawChannel 語義修正）。

## 6. 驗收（黃金判準）

- [x] V1 完整性〔2026-08-24 實測：4MB 隨機資料 0.91s 完成，SHA-256 一致，吞吐 4.4 MB/s 含加密〕。
- [x] V2 同意制：無 handler／明示拒絕單元 2 例（reason 透出）。
- [x] V3 fail-visible：取消/關閉單元覆蓋（含早取消旗標修正）。
- [x] V4 表面受控：fitness 快照顯性更新；prune gate 綠。
- [x] V5 既有測試零回歸（1692 綠；close 語義變更同步修訂 023 的一例測試斷言並記錄）。

## 7. 一致性自查（analyze，implement 前跑一次）

- [x] 第 4 節方案覆蓋第 1 節全部需求，無多做：需求＝分塊/進度/完整性/同意/取消；斷線續傳/串流/廣播依第 2 節排除。
- [x] 第 5 節任務完整實現第 4 節，無遺漏。
- [x] 第 6 節驗收能證明第 1 節：V1 驗完整性（核心），V2 驗同意制（安全面），非只驗跑得動。
- [x] 未違反憲法任何一條：E2EE 走既有密封管線；上限與不做的事全部明示（第 10 條）。
