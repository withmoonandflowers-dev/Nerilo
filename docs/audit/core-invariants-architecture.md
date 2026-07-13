# Nerilo 核心不變量稽核：架構圖集

依實際程式碼產生（2026-07-13，branch feature/p2c-keyx-live-mesh @ 957bb2c）。不含虛構服務。

## 1. 系統總體架構

```mermaid
flowchart TB
    subgraph UI["UI 層"]
        VUE["web-vue (Nuxt, production 目標)"]
        REACT["src/features/* React (凍結)"]
    end
    subgraph SDK["SDK 門面 (src/sdk)"]
        NC["NeriloClient"]
        ICE["IChatEngine 契約"]
    end
    subgraph CORE["core (零 firebase 靜態依賴)"]
        MCS["MeshChatService"]
        MGM["MeshGossipManager"]
        GMH["GossipMessageHandler<br/>簽章/加密/去重/anti-entropy"]
        MTM["MeshTopologyManager<br/>發現/重連/rejoin"]
        MC["MeshConnection → P2PManager<br/>WebRTC DataChannel"]
        KEYX["RoomKeyCoordinator<br/>sender key epoch"]
        CRED["CreditLedger + CoSignedReceipt"]
        COUR["CourierStore/Service (盲信使)"]
    end
    subgraph PORTS["注入縫 (ports)"]
        SIG["SignalingTransport"]
        DIR["IRoomDirectory"]
        STO["IChatStorage"]
    end
    subgraph ADAPTERS["adapters"]
        FSIG["RoomSignalingTransport (Firestore)"]
        FDIR["FirestoreRoomDirectory"]
        IDB["IndexedDBService"]
        MEM["InMemory* (SDK 參考/測試)"]
    end
    FB[("Firebase Auth + Firestore<br/>signaling/名冊/密文備援")]

    VUE --> MCS
    NC --> ICE --> MCS
    MCS --> MGM --> GMH & MTM & KEYX
    MTM --> MC
    MCS -.-> STO
    MC -.-> SIG
    MTM & MGM -.-> DIR
    SIG --- FSIG & MEM
    DIR --- FDIR & MEM
    STO --- IDB & MEM
    FSIG & FDIR --> FB
```

## 2. 訊息送收時序（恰好一次的機制）

```mermaid
sequenceDiagram
    participant A as 寄件端
    participant S as GossipMessageHandler(A)
    participant N as 鄰居(mesh)
    participant R as 收件端
    A->>S: sendMessage(content, id, ts)
    S->>S: reserveSeq(持久原子保留, 失敗退記憶體++)
    S->>S: 房間金鑰加密(有 key), 簽章覆蓋密文
    S->>N: GOSSIP_MESSAGE(senderId, seq, sig)
    N->>R: 轉發(fanout, ttl)
    R->>R: 驗簽(fail-closed) + pubKey↔senderId 綁定
    R->>R: (senderId, seq) 去重(含 store floor)
    R->>R: 解密 → 落庫 → 顯示
    Note over N,R: 掉封包由 anti-entropy digest 對帳補送
    A-->>R: (覆蓋不足時) Firestore 密文備援, 同 messageId 去重
```

## 3. 金鑰分發（keyx）

```mermaid
sequenceDiagram
    participant O as 發鑰者
    participant D as IRoomDirectory
    participant M as 成員
    O->>D: 讀名冊 = meshIdentities ∩ participants
    O->>O: 產 epoch key, 逐成員 ECDH 封裝
    O->>M: keyx 紀錄(走 gossip, 簽章, 不再套房間金鑰)
    M->>M: 解出自己那份 → setContentKey(epoch)
    Note over O,M: 名冊形成期可能瞬時不一致(檔尾誠實邊界)<br/>keyx 不可用時退明文相容(UI 有加密指示)
```

## 4. 盲信使寄存與墓碑

```mermaid
sequenceDiagram
    participant S as 寄件端
    participant C as 信使(陌生節點)
    participant R as 收件端(離線→回線)
    S->>C: deposit(密文 record, 簽章可驗不可解)
    Note over C: CourierStore(記憶體權威 + IndexedDB 鏡像)
    R->>C: pull(回線後) / anti-entropy 對帳
    C->>R: 密文 records
    R->>R: 解密 + (senderId, seq) 去重
    R->>C: tombstone(房籍簽章) → 信使驗簽即刪
    C->>S: 共簽收據(轉發證明) → CreditLedger 入帳
```

## 5. 點數：收據到入帳

```mermaid
flowchart LR
    F["信使完成轉發"] --> D["ReceiptDraft(信使簽)"]
    D --> V1["requester 驗 draft 後共簽"]
    V1 --> RC["CoSignedReceipt(雙簽)"]
    RC --> V2["verifyReceipt(雙簽驗證)"]
    V2 --> L["CreditLedger.append(earn)<br/>雜湊鏈 + 本地簽章"]
    L --> B["餘額 = 重放 earn/spend 日誌"]
    style L stroke-dasharray: 5 5
```
註：Ledger 本身不強制「earn 必附收據」，正當性由呼叫端承擔（見風險 R5）。

## 6. 訊息狀態

```mermaid
stateDiagram-v2
    [*] --> sending: 樂觀顯示
    sending --> sent: gossip 送出
    sent --> delivered: (1.5s 樂觀) / 對端回收斂
    sending --> failed: 加密失敗/超時
    failed --> sending: 重送(同 id 去重)
    delivered --> read: 對端已讀水位 ≥ orderKey
```

## 7. 部署拓撲

```mermaid
flowchart LR
    U1["瀏覽器 A"] <-->|"WebRTC DataChannel(E2EE)"| U2["瀏覽器 B"]
    U1 <-->|mesh| U3["瀏覽器 C"]
    U1 & U2 & U3 <-->|"signaling/名冊/密文備援"| FB[("Firebase<br/>Hosting + Auth + Firestore")]
    CI["GitHub Actions<br/>ci.yml + firebase-deploy.yml"] --> FB
    TURN["社群 TURN(健康檢查輪替)"] -.-> U1 & U2 & U3
```
