# Nerilo 架構 — C4 模型

> 現況快照（2026-07-04）。四層 C4：Context → Container → Component → Code。
> 誠實標註 dormant（已測未接線）與 not-deployed（存在但未上 production）的部分，
> 對齊 ADR-0007（模組分類）、ADR-0009（資料傳遞架構）、ADR-0015（遊戲為第二應用）。

Nerilo 一句話定位：**傳輸中立的 P2P 即時資料平台**；聊天與遊戲是騎在同一條
DataChannel 上、以 namespace 區分的「參考應用」，房間是「資料流容器」不是聊天室。

---

## C1 — System Context

誰用它、它依賴哪些外部系統。

```mermaid
flowchart TB
    peer["👤 Peer（使用者瀏覽器）<br/>建立/加入房間，收發資料"]

    subgraph nerilo["Nerilo 平台"]
        spa["Nerilo Web App<br/>(React SPA)"]
    end

    auth["Firebase Auth<br/>（Google 身分）"]
    fs["Cloud Firestore<br/>signaling · 密文 fallback · 房間登錄 · 配額 rules"]
    ice["STUN / TURN<br/>ICE / NAT 穿透"]
    ls["Lemon Squeezy<br/>（Merchant of Record，台灣無 Stripe）"]
    nf["Netlify Function<br/>ls-webhook（計費不依賴 Blaze，ADR-0008）"]
    sentry["Sentry（可退出遙測）"]

    peer <-->|WebRTC DataChannel P2P| peer2["👤 其他 Peer"]
    peer --> spa
    spa --> auth
    spa --> fs
    spa --> ice
    spa -->|升級付費| ls
    ls -->|webhook 簽章| nf
    nf -->|firebase-admin 設 plan=pro custom claim| auth
    spa -.可退出.-> sentry

    style nerilo fill:#efe7e4,stroke:#b5838d
    style spa fill:#fff,stroke:#b5838d
```

**要點**
- 資料平面（peer↔peer 的實際內容）走 **WebRTC DataChannel**，不經任何伺服器。
- Firestore 只做**控制平面**：signaling（SDP/ICE 交換）、房間登錄與配額、P2P 失敗時的**密文** fallback relay。
- 金流刻意繞開 Firebase Blaze：LS webhook 由 **Netlify Function** 承載，經 firebase-admin 寫 custom claim。

---

## C2 — Container

可獨立部署/執行的單位與其資料存放。

```mermaid
flowchart TB
    subgraph browser["瀏覽器（每個 Peer）"]
        spa["React SPA<br/>Vite build · Firebase Hosting<br/>(nerilo.web.app)"]
        idb[("IndexedDB<br/>ECDSA 身分金鑰 · 聊天歷史 · 遊戲狀態")]
        spa --- idb
    end

    dc{{"WebRTC DataChannel<br/>ordered+reliable（主資料平面）"}}
    spa <-->|E2EE payload| dc
    dc <-->|另一 Peer| spa2["React SPA（其他 Peer）"]

    subgraph firebase["Firebase 專案"]
        auth["Firebase Auth"]
        fs[("Cloud Firestore<br/>signaling · p2pRooms · 密文 fallback")]
        cf["Cloud Function cleanupRooms<br/>⚠️ 編譯驗證但未部署<br/>（改用原生 TTL，M2）"]
    end

    subgraph netlify["Netlify"]
        webhook["ls-webhook.mts<br/>驗簽 → firebase-admin"]
    end

    ext_ls["Lemon Squeezy"]
    ext_ice["STUN / TURN"]

    spa --> auth
    spa --> fs
    spa --> ext_ice
    ext_ls --> webhook
    webhook --> auth

    style spa fill:#fff,stroke:#b5838d
    style dc fill:#d8e2dc,stroke:#6b8f71
    style cf fill:#f5e6e0,stroke:#c98,stroke-dasharray:4
```

**要點**
- SPA 部署於 **Firebase Hosting**；master push 自動 build+deploy（含 Firestore rules/indexes）。
- **Cloud Functions 從未上 production**：`cleanupRooms` 僅在 CI 編譯驗證；房間回收改用 Firestore 原生 TTL policy（M2）。
- CSP / 安全標頭在 `firebase.json` 收斂（`connect-src` 白名單含 googleapis/firebaseio/sentry）。

---

## C3 — Component（React SPA 內部）

`src/` 內部依「平面」分組。粗體=已接線，斜體=dormant（已測未接線，ADR-0007 第 1 類戰略資產）。

```mermaid
flowchart TB
    subgraph app["應用層 features / services / hooks"]
        chat["**features/chat**<br/>ChatPage · ChatService · MeshChatService"]
        room["**services**<br/>RoomService · FirestoreChatFallback · IndexedDBService"]
        ui["**components / contexts**<br/>ConnectionGlobe(cobe) · ThemeContext · Auth/Services/Feature Context"]
        hooks["**hooks**<br/>usePlan · usePeerGlobe"]
        ports["**ports**（hexagonal 邊界）<br/>IRoomService · IChatStorage"]
    end

    bus["**core/p2p/P2PChannelBus**<br/>envelope 驗證 + namespace 分派（架構脊椎）"]

    subgraph conn["連線與 signaling（已接線）"]
        p2pm["**P2PManager / MultiP2PManager**<br/>P2PConnectionManager · HelloNegotiator · IceServerProvider"]
    end

    subgraph mesh["mesh（2–5 人已接線）"]
        gossip["**MeshGossipManager** · Topology · Heartbeat · IdentityManager"]
    end

    subgraph crypto["crypto E2EE"]
        sk["**SenderKeyManager** · ECDHKeyExchange"]
        tk["*GroupKeyManager · TreeKEMManager*"]
    end

    subgraph advanced["進階資料平面（dormant）"]
        relay["*relay: RelayManager · Sphinx · Kademlia · PeerScoring*"]
        ord["*ordering / clock: HLC*"]
        inc["*incentive: LocalCreditProvider*"]
        tr["*transport: FirestoreRelay · StoreAndForward · MultiChannelBus*"]
    end

    subgraph gamegrp["game SDK（解凍，ADR-0015）"]
        game["**GameTransportSDK** · World · GameLoop<br/>**schema / InputCodec（ADR-0018 新增）**"]
        comm["*community: roles · governance*"]
    end

    chat --> bus
    game --> bus
    hooks --> bus
    chat --> room
    room --> ports
    bus --> p2pm
    bus --> mesh
    bus --> crypto
    p2pm -.signaling.-> room
    bus -.-> advanced

    style bus fill:#b5838d,color:#fff,stroke:#6d4c52
    style app fill:#efe7e4,stroke:#b5838d
    style advanced fill:#f5f0ee,stroke:#bba,stroke-dasharray:4
    style tk fill:#f5f0ee,stroke-dasharray:3
```

**要點**
- **P2PChannelBus 是脊椎**：所有 feature 用 `subscribe(ns, handler)` / `send(envelope)`；
  以 `envelope.ns` 分派（`chat` / `game` / `presence` …），核心協議零耦合到任何應用。
- 目前**實際接線**：2 人星型（P2PManager）、3–5 人 mesh gossip、E2EE（SenderKeyManager）、
  chat、payment/plan、地球 presence、game SDK（demo 排 M4）。
- **dormant 戰略資產**（已測未接線）：relay 洋蔥路由 + Kademlia DHT、HLC 排序、
  信用經濟、store-and-forward、TreeKEM 群組金鑰、community 治理。

---

## C4 — Code：出站訊息路徑（脊椎 P2PChannelBus）

放大「一則 payload 如何從應用送到對端」，展示 envelope 契約與 fallback。

```mermaid
sequenceDiagram
    participant F as feature<br/>(chat / game)
    participant B as P2PChannelBus
    participant E as SenderKeyManager
    participant DC as WebRTC DataChannel
    participant FS as Firestore（fallback）

    F->>B: send(envelope)
    Note over B: validateEnvelope<br/>必要欄位 v/ns/type/id/ts/from/payload
    B->>E: 以 group sender key 加密 payload（AES-256-GCM）
    E-->>B: 密文 envelope
    alt DataChannel 已開（主路徑）
        B->>DC: 送密文
        DC-->>B: 對端 P2PChannelBus 依 ns 分派給對應 subscribe(handler)
    else P2P 未就緒（備援）
        B->>FS: 寫入密文 fallback（rules 驗身分/配額）
        Note over FS: 對端訂閱該房 fallback 集合，收後解密
    end
```

**envelope 契約（型別 `P2PEnvelope`）**

| 欄位 | 意義 |
|---|---|
| `v` | 協議版本（跨版相容） |
| `ns` | namespace，決定分派對象（chat / game / presence） |
| `type` | 應用內訊息型別 |
| `id` / `ts` / `from` | 去重 / 排序 / 來源 |
| `payload` | 應用資料（E2EE 後為密文；game 熱路徑可走 ADR-0018 binary codec） |

**設計不變式**
- 核心 bus **不認識** namespace 清單——新應用只要自帶 `ns` 就能掛上（開閉原則）。
- Firestore 只見**密文**（ADR：fallback 也密文，含 `createdAt` 供 rules）。
- game INPUT 熱路徑可用 ADR-0018 的 `defineInput` 把 payload 從 ~60B JSON 壓到 ≤8B binary。

---

## 附：層級對照（快速索引）

| C4 層 | 對應 code |
|---|---|
| Container：SPA | `src/main.tsx` · `src/App.tsx` · Firebase Hosting |
| Container：webhook | `netlify/functions/ls-webhook.mts` |
| Component：脊椎 | `src/core/p2p/P2PChannelBus.ts` |
| Component：連線 | `src/core/p2p/*` |
| Component：E2EE | `src/core/crypto/SenderKeyManager.ts` |
| Component：房間 | `src/services/RoomService.ts` · `firestore.rules` |
| Component：game | `src/core/game/sdk/*`（含 `schema.ts` · `InputCodec.ts`） |
| Code：契約 | `src/types`（`P2PEnvelope`） |
