# 社群 TURN 伺服器捐贈指南（ADR-0012 P1）

Nerilo 的 P2P 直連約有 8–15% 的配對因 NAT 受阻需要 TURN 中繼。
你可以捐一台跑 coturn 的 VPS，讓這些配對「連得上」——這是社群對平台
最直接的效能貢獻。

## 如何登錄

對 `public/community-turn.json` 發 PR，在 `servers` 陣列加入：

```json
{
  "urls": ["turn:turn.example.org:3478", "turns:turn.example.org:5349"],
  "username": "nerilo",
  "credential": "你的靜態密碼",
  "contributor": "你的 GitHub id（選填，供致謝）",
  "region": "asia-east（選填，供未來就近選路）"
}
```

必填：`urls`（`turn:` 或 `turns:` 開頭）、`username`、`credential`。
其餘欄位 client 會忽略但保留在登錄檔供人閱讀。

**git 歷史即審計軌跡**：誰加的、何時加的、誰核准的，一目了然。

## 你必須理解的風險（誠實條款）

1. **credential 是公開的**。任何人（包括其他應用）都能拿去用你的 TURN。
   請務必在 coturn 設限：
   ```
   # turnserver.conf 建議
   user-quota=12          # 每帳號並行 session 上限
   bps-capacity=1000000   # 總頻寬上限（bytes/s），依你的 VPS 調
   no-multicast-peers
   denied-peer-ip=10.0.0.0-10.255.255.255   # 擋內網掃描
   denied-peer-ip=192.168.0.0-192.168.255.255
   denied-peer-ip=172.16.0.0-172.31.255.255
   ```
2. **你看不到內容**：DataChannel 走 DTLS，TURN 只中繼密文——但你看得到
   流量的 IP 與時間 metadata。
3. **隨時可退出**：發 PR 移除自己即可；client 端清單快取 12 小時內失效。

## Client 端行為（你被如何使用）

- 清單經 same-origin 靜態檔載入（隨站台部署），壞條目逐筆丟棄。
- 首次使用後 client 會做 **relay-only 健康探測**（5 秒）：探測失敗的
  伺服器會被後續連線過濾，不會反覆打死機器。
- 停用開關：使用者端 `VITE_COMMUNITY_TURN=off`。

## 未來（尚未實作，勿預期）

- region 就近選路
- 過路點數（ADR-0011）計入 TURN 捐贈者 —— 需先解防刷（女巫）問題
