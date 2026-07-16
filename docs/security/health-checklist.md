# Nerilo 系統健康 checklist（防範導向）

> 配合 [threat-model.md](threat-model.md)。這份是**操作面**：定期做什麼、
> 上線前檢查什麼、出事時看哪裡。目標是讓系統「持續健康」而非一次性稽核。

## 已就位的防線（本輪強化）

| 防線 | 機制 | 位置 |
|---|---|---|
| 惡意 peer 畸形 payload | envelope 嚴格型別驗證 + 原型污染字樣擋除 | `P2PChannelBus.validateEnvelope` |
| DataChannel OOM | 256KB 上限，JSON.parse 前先擋 | `P2PChannelBus` MAX_INBOUND_MESSAGE_BYTES |
| 相依套件 CVE | Dependabot 每週自動 PR（含 /functions） | `.github/dependabot.yml` |
| 社群 TURN metadata | 僅無自營 TURN 時啟用 + 健康探測 | `IceServerProvider`（威脅模型 F2） |
| 殭屍房 / 活房誤殺 | 房主心跳 + TTL 過濾 | `RoomHeartbeat` |
| 短命 Firestore 資料 | `expiresAt` rules 上限 + 原生 TTL 設定腳本 | `firestore.rules`、`scripts/setup-ttl-policies.sh` |
| Functions 漂移 | Functions TypeScript build 為 CI 硬閘 | `.github/workflows/ci.yml` |

## 每週（多為自動）

- [ ] 看 Dependabot PR：**security 標籤優先**合併；firebase-admin 傳遞漏洞在 /functions（後端專用，client 不暴露，但仍追）。
- [ ] `npm audit --omit=dev` 快掃 client 面向漏洞（dev 相依不進 bundle 可略）。

## 每月

- [ ] 看 P0 連線數據（`?metrics=1` → console）：`directSuccessRate` 掉太多代表可能被灌 TURN 或網路劣化；`fallbackMessages` 暴增代表可能有人在刷 Firestore。
- [ ] 抽查 Firestore 用量儀表板：p2pRooms 文件數或寫入異常成長 = 可能有人在刷房／信令；rules 與 TTL 只能限制形狀、大小和保留期，不能做可信總量速率限制。
- [ ] 檢視社群 TURN 登錄檔（`public/community-turn.json`）PR 歷史，確認沒有可疑登錄。

## 上線前（每次動到安全面）

- [ ] `npm run ci`（type-check + lint + unit）全綠。
- [ ] 動過 firestore.rules → 跑 rules 測試，確認 catch-all `allow read, write: if false` 仍在最後。
- [ ] 新增付費/權益功能 → 確認**伺服器端**（rules / plan claim）強制，不是只有 `usePlan` UI 擋（威脅模型 F6）。
- [ ] 新 P2P 訊息型別 → handler 有驗證 payload 型別，別信任遠端結構。

## 出事時看哪裡（incident runbook）

| 症狀 | 先看 | 可能原因 |
|---|---|---|
| Firestore 帳單暴衝 | 用量儀表板 p2pRooms 寫入數 | 大量建房（F1）／signal 洗版 |
| 有人自稱 Pro 沒付錢 | Netlify webhook log + Firebase custom claims | webhook 簽章密鑰外洩？claim 手動被改？ |
| 使用者說訊息被別人看到 | 不可能是內容（E2EE）；查是否 metadata 誤判 | 房間 participants 外洩、public 房設定 |
| 連線大量失敗 | P0 `directSuccessRate` + TURN 健康 | TURN 掛掉／被 DoS／ICE 設定 |

## 尚未關閉的已知風險（追蹤中）

- **F1 全域寫入速率無可信上限**：rules 已有限制結構、大小與 expiry，原生 TTL 腳本已備；跨帳戶／跨裝置的可信總量配額仍需 Blaze Functions 或其他伺服器執行點。
- **F5 TOFU 無驗證 UI**：可加公鑰指紋比對（Signal 式 safety number）。
- **F4 metadata**：MessagePadding（256B 分塊）dormant，未接。
