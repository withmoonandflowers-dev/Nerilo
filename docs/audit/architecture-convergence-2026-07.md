# Nerilo 架構收斂與平台化就緒稽核

日期：2026-07-16。方法：`docs/PROMPT-architecture-convergence.md`。對象：`src/core`、`src/sdk`、`src/features`、`web-vue/app`。全部數字為實測。

## 前置：消費者與契約

- 消費者：(1) 應用層（本專案前端 + 未來第三方產品）經 SDK；(2) AI agent 經 MCP（規劃）。
- 契約：`src/sdk/index.ts` 公開表面（semver 0.x）、Protocol Spec 003（欠條）、既有 ADR。
- 意圖：讓別人「建房間 / 收發訊息 / 查狀態」，不需要認識 mesh/keyx/courier 內部。

## ① 適應度快照（指標 × 現值 × 目標）

| 指標 | 現值 | 目標 | 判讀 |
|---|---|---|---|
| SDK barrel 對外匯出項 | 16 | 維持 <25 | ✅ 表面本身小 |
| npm 型別檔洩漏內部模組 | **141 / 184 個 .d.ts 是 core/features/services 內部** | 只出 sdk + ports 型別 | 🔴 最大洩漏：API 小但把內臟全攤開 |
| 邊界違規（ESLint no-restricted-imports） | 0 | 0 | ✅ 適應度函數綠 |
| 依賴環 | 0（madge 掃 122 檔） | 0 | ✅ 無環、可抽 |
| 產品流 0 引用的 core 模組 | community/chain/ledger/metrics/transport/protocol = **5513 行**；core/game ECS 引擎 ~3985 行；TreeKEM | 明確處置（刪或凍結+觸發條件） | 🔴 約 35% 的 core 是死重 |
| god-file（>800 行） | 4：ChatPage 1203、[roomId].vue 1170、RoomService 1054、dashboard 861 | 拆到 <500 | 🟡 集中在 UI 與 RoomService |
| 耦合熱點 | types(~90，中立層，正常)、P2PChannelBus(10)、SignalingTransport(9) | 樞紐可控 | ✅ 無異常上帝模組 |

## ② 最大架構債（一句話）

**不是耦合（那塊乾淨），是「地基被死重與洩漏的內臟埋住，消費者看不清這到底是什麼」**：SDK 型別把 141 個內部模組攤在消費者面前，加上 ~35% 的 core 從沒接進產品流，任何應用層或 AI agent 要接上來，第一眼看到的是一坨分不清「哪些是我該用的、哪些是內部機制」的東西。

## ③ 模組收斂決策（每個一個動詞）

| 模組 | 行數 | 產品流引用 | 處置 | 理由 |
|---|---|---|---|---|
| mesh | 4333 | 核心 | **KEEP-CORE** | 恰好一次、anti-entropy，地基本體 |
| p2p | 3097 | 核心 | **KEEP-CORE** | WebRTC/signaling/bus |
| crypto（扣 TreeKEM） | ~1100 | 核心 | **KEEP-CORE** | ECDSA/ECDH/AES-GCM/RoomKey |
| relay（信使+欠條） | 5660 | 有 | **SIMPLIFY** | 核心保留，但含 Sphinx/Kademlia 等未接部分，收窄 |
| incentive/ledger | 1797 | 有 | **KEEP-CORE** | 收據帳本已收斂（R5） |
| crypto/TreeKEM | ~400 | **0** | **DELETE / PARK** | 群組金鑰未來式，RoomKey 已夠用 |
| community | 2272 | **0** | **PARK**（明確凍結+觸發條件） | 治理/角色，無使用者前不需要 |
| game（ECS 引擎 World/GameLoop） | ~3500 | **0** | **EXTRACT / PARK** | UI 只用 features/game 薄層；ECS 引擎可抽成獨立套件或凍結 |
| chain | 936 | **0** | **DELETE / PARK** | 與 mesh 複寫日誌功能重疊 |
| transport（DHT/StoreAndForward） | 999 | **0** | **PARK** | 未接產品流 |
| metrics | 814 | **0** | **PARK** | 遙測，opt-in 未啟 |
| protocol | 91 | **0** | **DELETE** | 疑似殘留 |
| clock/ordering/storage | ~330 | 少量 | **KEEP** | 小而被用（HLC/因果序） |

死重合計約 8000-9000 行（core 約 26000 行的三分之一）。**這不是要你現在全刪**，是要你對每一塊給明確動詞、寫進 ADR，不再模稜兩可地「先留著」。

## ④ 最小穩定公開 API（給應用層）

現況：`NeriloClient` 門面已經是意圖形狀（connect/sendMessage/onMessage/loadHistory/react/markReadUpTo/dispose）。這很好。缺的是**把型別表面收乾淨**：

- tsconfig.sdk.json 只 emit `sdk/` + `ports/` + 必要公開型別的 .d.ts，不要 emit core/features/services 內部。目標：型別檔從 184 降到 <30。
- 加「公開表面快照測試」：`sdk/index.ts` 的匯出清單被改就要顯性 review。
- 「無痛抽換測試」已成立（InMemory adapter 可換 Firestore，消費者零改動）——這是乾淨的證據，保住它。

## ⑤ MCP 映射（給 AI agent）

好消息：`NeriloClient` 的方法幾乎就是意圖，MCP 工具幾乎是它的無狀態包裝。套五工具法則與 5-8 甜蜜點：

**成為工具（意圖）**：
- `nerilo_create_room`（建房，回 roomId + 邀請連結）
- `nerilo_join_room`（憑邀請連結加入）
- `nerilo_send_message`（送訊）
- `nerilo_get_messages`（取歷史/新訊）
- `nerilo_room_status`（連線/成員/加密狀態）
- `nerilo_list_rooms`（我的房間）

六個工具，落在甜蜜點內。

**留內部（機制，不該是工具）**：signaling、keyx、gossip、courier、ledger、pricing——agent 不需要、也不該碰。

**設計註記**：NeriloClient 是有狀態物件（connect/dispose 生命週期），MCP 工具是無狀態呼叫→ MCP server 要做 session 管理（roomId→live client 對應）。這是 MCP 對接的主要工作，不是重寫核心。

## ⑥ 把邊界變適應度函數（防止爛回去）

收斂後最怕慢慢退回。把上面的決策寫成 CI 會紅的測試：
- 擴充 ESLint 邊界（已有 core↛UI；再加「features↛其他 features 內部」「sdk 只能 import ports/types」）。
- **公開表面快照測試**：對 `sdk/index.ts` 匯出清單與 dist/types 檔數設上限，超過即紅。
- **死重棘輪**：PARK 的模組加 lint 規則「不得新增對它的 import」，凍結生效。
- **god-file 行數棘輪**：4 個 god-file 設當前行數為上限，只准變小。
- madge --circular 納入 CI，維持 0 環。

## ⑦ 重排（按「能不能被消費」的槓桿）

1. ~~**收乾淨型別表面**（tsconfig.sdk.json 只 emit 公開）——最高槓桿、最低風險，半天工。~~
   **已完成（2026-07-16）**，且比預估難：根因不是 emit 設定，是 barrel 把重型 Firestore 工廠（`createChatClient` 動態載入 MeshChatService）和純公開 API 綁在一起，加上 `SignalingTransport` 介面與 Firestore 實作同檔。修法＝(a) 工廠拆到 subpath `nerilo/firestore`、(b) 介面拆到 `SignalingTransport.types`、(c) tsc emit 後由 `scripts/prune-sdk-types.mjs` 依可達性修剪。**型別檔 186→16、npm 包 192→29 檔（231KB→99KB）**；prune 腳本 `--max=30` 兼作公開表面適應度函數。dts 打包工具（dts-bundle-generator）對本 codebase 的大型別圖會卡（@babel/types），故改用「tsc + 可達性修剪」。
2. ~~對死重逐塊拍板~~ **已完成（ADR-0031 + 死重圍籬 lint，驗證會擋）**。
3. ~~公開表面快照 + god-file 棘輪~~ **已完成（tests/unit/fitness.architecture.spec.ts，驗證會紅）**。
4. ~~**MCP server PoC**~~ **已完成（2026-07-16，Spec 008）**：六意圖工具＋SessionManager；引擎＝行程內 InProcessChatEngine 接 NeriloClient（「第三方自帶引擎」活證明；Node 無 WebRTC，真網路對接列 follow-up）。真 MCP client 整合測試 5/5。
5. god-file 拆分留到 React 退役（Spec 006 收斂時一起），不單獨動。
