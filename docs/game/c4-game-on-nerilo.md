# 遊戲 on Nerilo — C4 架構

> 主體是「你的遊戲」，Nerilo 是它依賴的傳輸底層（外部容器）。四層由遠而近。
> 前提：小型合作/回合制遊戲（見 ADR-G01）。以「2 人回合制」為具體範例。

---

## C1 — System Context

```mermaid
flowchart TB
    p1["👤 玩家 A"]
    p2["👤 玩家 B"]
    subgraph game["你的遊戲（System）"]
      g["遊戲 client"]
    end
    nerilo["Nerilo 傳輸底層<br/>P2P DataChannel · E2EE · SDK"]
    fb["Firebase<br/>（經 Nerilo）signaling + 房間"]

    p1 --> g
    p2 --> g
    g -->|收送遊戲資料| nerilo
    nerilo <-->|玩家間直連 P2P| nerilo
    nerilo -.牽線/房間.-> fb

    style game fill:#eef,stroke:#66c
    style nerilo fill:#efe7e4,stroke:#b5838d
```

**要點**：玩家的遊戲資料經 Nerilo 在兩端直連流動，不經你的伺服器。
Firebase 只做牽線與房間（Nerilo 已包好，你不直接碰）。

---

## C2 — Container

```mermaid
flowchart TB
    subgraph client["遊戲 client（瀏覽器）"]
      logic["遊戲邏輯 + 渲染<br/>（你寫）"]
      sdk["Nerilo 遊戲 SDK<br/>GameSession / codec（用）"]
      logic --> sdk
    end

    ctrl{{"控制通道<br/>可靠有序（輸入/回合/房主）"}}
    state{{"狀態通道<br/>不可靠（高頻位置，選用）"}}

    sdk --> ctrl
    sdk --> state
    ctrl <-->|另一玩家| client2["遊戲 client（對端）"]
    state <-->|另一玩家| client2

    fb[("Firebase<br/>signaling + p2pRooms")]
    sdk -.經 Nerilo.-> fb

    style client fill:#eef,stroke:#66c
    style ctrl fill:#fff,stroke:#b5838d
    style state fill:#d8e2dc,stroke:#6b8f71
```

**要點**：
- 你寫「遊戲邏輯 + 渲染」；Nerilo SDK 給你 `GameSession` + 兩條通道 + codec。
- 回合制只需**控制通道**（可靠）。要 60Hz 位置同步才用**狀態通道**（不可靠）。

---

## C3 — Component（遊戲 client 內部）

```mermaid
flowchart TB
    subgraph yours["你寫的（遊戲層）"]
      loop["Game Loop / 規則"]
      input["輸入處理"]
      render["渲染 / UI"]
      match["配對 / 大廳（自建或借 Firebase auth）"]
    end
    subgraph adapter["接線層（薄）"]
      net["Netcode adapter<br/>遊戲事件 ↔ Nerilo envelope/幀"]
    end
    subgraph nerilo["Nerilo（用，不改）"]
      session["GameSession<br/>成員/seed/房主接替"]
      bus["P2PChannelBus（可靠 ns='game'）"]
      sc["StateChannel（不可靠幀）"]
      codec["defineInput / defineStateFrame（二進位）"]
    end

    input --> loop
    loop --> net
    net --> session
    net --> bus
    net --> sc
    net --> codec
    loop --> render
    match -.房間.-> session

    style yours fill:#eef,stroke:#66c
    style nerilo fill:#efe7e4,stroke:#b5838d
```

**權責邊界（最重要）**：
- **你寫**：遊戲規則、輸入、渲染、配對/大廳、（若需要）反作弊。
- **Nerilo 給**：把 bytes 安全送到對端、成員/seed/房主接替、二進位編碼。
- 中間一層薄 **Netcode adapter**：把你的遊戲事件轉成 Nerilo 的 envelope/幀,反之亦然。

---

## C4 — Code：一回合的資料流（回合制範例）

```mermaid
sequenceDiagram
    participant A as 玩家 A 遊戲
    participant BUS as P2PChannelBus (ns='game')
    participant B as 玩家 B 遊戲

    A->>A: 玩家下一步（輸入）
    A->>BUS: send({ns:'game', type:'MOVE', payload:{cell:4}})
    Note over BUS: 可靠有序 + E2EE
    BUS-->>B: subscribe('game') handler 收到 MOVE
    B->>B: 套用對手的一步 → 更新棋盤 → 渲染
    Note over A,B: 雙方各自用相同規則推進（lockstep）；<br/>state-hash 定期比對防 desync（非防競技作弊）
```

**高頻動作遊戲的差異**：位置流改走 `StateChannel.send(Frame.encode(seq, rosterVer, {x,y}))`
（不可靠、丟幀天然覆蓋），收端 `FrameGate` 丟 stale 幀。控制訊息（房主/回合/名冊）
仍走可靠通道。

---

## 對照索引

| C4 層 | 對應 Nerilo API |
|---|---|
| 控制通道 | `P2PManager.getChannelBus()` → `subscribe('game')` / `send(envelope)` |
| 狀態通道 | `P2PManager.getStateChannel()` → `send(bytes)` / `onFrame` |
| 成員/seed/房主 | `GameSession`（`src/core/game/sdk/GameSession.ts`） |
| 二進位編碼 | `defineInput` / `defineStateFrame` / `defineComponent` |
| 版本協商 | HELLO `strictProtocols: { yourgame: N }` |
