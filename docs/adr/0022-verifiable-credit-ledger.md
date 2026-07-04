# ADR-0022：可驗證點數帳本（簽章收據 + 雜湊鏈）

- 狀態：Accepted
- 日期：2026-07-04
- 相關：ADR-0011（點數經濟）、ADR-0020（CreditEconomy）、ADR-0021（中繼即價值）

## Context

點數要「帳本正確、防竄改」，但完整區塊鏈方案成本過高（gas、錢包、代幣、法遵、
永久維護），對零使用者階段是純負擔。經 goal 分析：真正需要的是「防竄改 + 可驗證」，
而非「去中心共識 + 可流通」。前者用**簽章收據 + 雜湊鏈**即可達成，成本接近零。

原點數（CreditEconomy）餘額是 localStorage 一個數字——不可驗證、可被本人或第三方
任意改。本 ADR 補上可驗證性。

## Decision

新增 `CreditLedger`（`src/core/incentive/CreditLedger.ts`）——append-only 可驗證帳本：

1. **雜湊鏈**：每筆 `hash = SHA256(canonical(seq,prevHash,op,amount,reason,ts,nonce))`。
   插入/刪除/竄改/重排任一筆 → 後續 prevHash/seq/hash 對不上，`verify()` 回報第一個斷點。
2. **簽章收據**：每筆用身分金鑰（ECDSA P-256，可注入 `LedgerSigner`）簽 hash。
   第三方無法偽造他人 entry；`webCryptoSigner` 提供真實 WebCrypto 實作。
3. **餘額 = 重放**：`balance()` 由日誌加總，非獨立數字——餘額正確 ⇔ 日誌完整。
4. **併發安全**：append 內部序列化（雜湊鏈需嚴格順序）；`settled()` 等佇列落定。

整合 `CreditEconomy.attachLedger()`：掛帳本後每筆 earn（uptime/relay）/spend 以
**實際套用的差額**記成簽章 entry（節流後為 0 就不記，故帳本與餘額一致）。
`verifyLedger()` / `exportLedger()` 供稽核。純加法，未掛帳本時行為不變。

### 誠實邊界（寫清楚免誤解）

- **完整性 ≠ 正當性**：帳本保證「記錄沒被竄改」，**不保證**「點數是公平賺的」。
  garbage in → 不可竄改的 garbage out。防「本人偽造賺點」需**防女巫**（App Check +
  非匿名）+ **交易對手共簽收據**（earn 由 requester 一起簽，見 RelayReceipt 雙簽），
  那是上游正當性層，非本帳本的完整性層。
- **自簽自有日誌**能防第三方竄改與事後偷改（鏈斷），但擋不了持金鑰的本人重寫整條並
  重簽。要跨主體不可否認，需共簽 / 外部時間戳 / 錨定——屬後續。

## Consequences

- **好處**：點數帳本可驗證、防竄改，成本接近零（無 gas/錢包/代幣/法遵）。這是
  ADR-0011 blockchain Phase 2 的**務實前身**——同樣的 IIncentiveProvider 上層，
  日後若真需去中心/流通再換區塊鏈，介面不變。
- **成本/風險**：帳本會隨異動增長（需截斷/快照策略，量大時再做）；正當性（女巫）
  仍未解，帳本忠實記錄可能不公平的餘額。
- **已交付**：CreditLedger（雜湊鏈+簽章+verify+併發安全）、真實 ECDSA 測試 +
  全竄改情境（改額/刪/插/重排/偽章）、CreditEconomy attachLedger 整合 + 測試。
