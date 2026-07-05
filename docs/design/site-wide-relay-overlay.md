# 全站中繼 Overlay（Phase 2 設計，未實作）

- 日期：2026-07-05；承接 ADR-0021（中繼即價值）、ADR-0011（點數）
- 現況：點數在「有活躍 P2P 連線」時真實累積（在線累積 + recordRelayContribution）；
  dashboard 顯示「節點待命中／節點中繼中」＋餘額。**沒有連線時不賺點、不顯示假狀態。**

## 目標

「只要開著 Nerilo，就是網路的一個中繼節點」——不在任何聊天室也能為他人轉發
（Sphinx-Lite 洋蔥層已有，src/core/relay/），並以真實轉發量賺點。

## 需要補的三件事

1. **全域 signaling 名冊**：現行 signaling 綁在 p2pRooms/{roomId}/signals；
   站級 overlay 需要獨立的 `relayDirectory`（在線節點註冊 + TTL 心跳 +
   NAT 能力標記），供陌生節點互相發現、建立 relay-only DataChannel。
2. **配額與防濫用**：RateLimiter/PeerScoring 已有，但站級節點面向陌生流量，
   需要（a）每 IP/uid 併發連線上限、（b）流量上限（電量/流量友善）、
   （c）使用者可關閉的開關（預設開，設定頁）。
3. **點數的可信計量**：本機自報 bytesRelayed 可刷點。ADR-0022 共簽收據
   （雙方簽名的中繼證明）已有原語，站級接線時改用共簽收據餵
   recordRelayContribution，Phase 1 本機記帳僅供展示。

## 不做的事

- 不做假的「中繼動畫/點數跳動」——UI 只反映真實事件（誠實條款）。
- 不在行動裝置背景常駐（瀏覽器限制 + 電量），文案明示「開著頁面才在線」。

## 驗收（到時）

兩個互為陌生人的瀏覽器 A、C 不同房，B 開著 dashboard；A→C 的備援流量
經 B 轉發（而非 Firestore），B 的餘額以共簽收據增加。
