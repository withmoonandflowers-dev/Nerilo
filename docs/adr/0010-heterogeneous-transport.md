# ADR-0010：異質傳輸擴展原則（衛星、LoRa、業餘無線電）

- 狀態：Proposed（原則現在定，實作排 M5）
- 日期：2026-07-03

## Context

產品負責人確認需求：具備相應硬體的設備，應能透過衛星通訊或
Meshtastic / 業餘無線電 mesh 接入 Nerilo 的資料傳遞架構。

現況盤點（詳細對照見 GOAL-ANALYSIS 第 3 節）：

- 核心假設寬頻：envelope 是 JSON 文字（P2PChannelBus.ts:206、212），
  relay 層用 4KB 固定封包與 cover traffic。LoRa 每包約 237 bytes、
  速率數百 bps 等級，這些假設全數不成立。
- 法規現實：業餘頻段禁止以加密遮蔽內容（台灣 NCC、美國 FCC Part 97 同旨），
  與「E2EE 預設」的安全契約直接衝突。ISM 頻段的 Meshtastic 則可合法 AES。
- 訊息型衛星（Iridium SBD 等）按則計費，與零邊際成本紅線衝突。
- 有利面：HLC（免時鐘同步）、StoreAndForward、CausalOrderingBuffer、
  MessageAssembler 去重，正是延遲容忍網路（DTN）需要的原語，
  且瀏覽器可經 Web Bluetooth / Web Serial 連 Meshtastic 節點（Chromium 限定）。

風險：若 M4 平台抽取時契約只為 WebRTC 設計，之後為窄頻通道翻修契約
是破壞式變更，所有已接入系統都要跟著改。

## Decision

現在只決定契約形狀，不實作任何 RF 通道：

1. **傳輸契約自 M4 起就是分級的**。每個 transport adapter 宣告三個維度：
   - 頻寬等級：broadband（WebRTC、IP 衛星）、narrowband（LoRa）、
     message（訊息型衛星）
   - 安全等級：e2ee、sign-only、plaintext
   - 送達模式：realtime、delay-tolerant
2. **安全是通道標籤加應用策略，不是全域布林**。應用層宣告資料流的
   最低安全等級，路由器不得將資料送往低於宣告等級的通道；預設最低等級
   為 e2ee，降級必須由應用顯式宣告且 UI 可見。這化解 ham 頻段的法規衝突
   而不侵蝕預設安全。
3. **線格式與語義能力放進契約**：payload 一律定義於二進位緊湊編碼
   （寬頻通道可繼續以 JSON 承載，但契約層以二進位為準），分片重組與
   去重（MessageAssembler 上移）屬傳輸層公共設施；匿名性（Sphinx、
   cover traffic）明確標示為 broadband 專屬能力。
4. **成本歸因進契約**：通道宣告單位成本屬性（零邊際、計量計費），
   計量通道的用量必須可歸因至使用者（GB4 配額機制共用），為 GX5
   離網市場的計費鋪路。
5. **實作順序**：M5 第一個目標是 Meshtastic ISM 頻段（合法加密、
   硬體便宜、社群現成）經 Web Bluetooth/Serial 接入；ham licensed mode
   與訊息型衛星列第二批。IP 衛星（Starlink）不需要任何工作，今天即支援。

## Consequences

- M4 的契約設計成本略增（多三個宣告維度），換取 M5 不做破壞式變更。
- 窄頻通道不提供匿名性與大 payload，平台文件必須誠實標示各通道能力矩陣（呼應 GP2 誠實原則）。
- 瀏覽器接 RF 硬體依賴 Web Bluetooth / Web Serial，Safari 與 Firefox 不支援；「瀏覽器即產品」的邊界在 RF 場景收窄為 Chromium 系，路線圖「不做原生 app」原則在此場景需要豁免評估（可能以小型本機 bridge 程式補位）。
- 災防與離網市場成為 GB 支柱的新分支，與台灣的地震颱風災防情境有天然契合，作為未來資源申請的敘事素材。
- 業餘頻段通道永遠是 sign-only 或 plaintext，法規變更前不嘗試任何形式的內容加密。
