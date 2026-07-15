# ADR-0028：帳本賺點必附正當性證明（收斂稽核 R5）

日期：2026-07-14。狀態：已落地。關聯：Spec 002、ADR-0022、稽核風險 R5、Spec 001（依賴本項）。

## 背景

稽核 R5：CreditLedger 的 earn 在型別層不強制收據參照，正當性只靠呼叫端自律，
理論上可繞過收據直接加點。Spec 001 的寄存經濟以「點數只能靠可驗證貢獻取得」為地基。

## 決策

earn 型 append 必附 `EarnAttestation`，帳本內部 fail-closed 把關：

- `receipt`：共簽收據入帳前 `verifyReceipt` 雙簽驗證（信使已驗過、帳本再驗一次，縱深防禦）。
  收據摘要以 `receipt:<sha256 前 16>` 寫入 entry。
- `self`：無交易對手的事由白名單（uptime/grant），以 `self:<basis>` 明白標注，稽核可辨識。
  這是誠實妥協：在線累積天然無對手可共簽，硬要求收據會弄壞運作中路徑；改為顯性標注
  而非默許，白名單外一律拒。
- attest 納入 canonical 進雜湊鏈（事後竄改斷鏈）；舊持久化資料（無 attest）維持可驗。
- 型別（overload）+ 執行期雙層強制；收據沿 CourierService onCredit 傳遞至帳本。

## 取捨

- spend 不要求證明：花錢無正當性問題，餘額檢查在上游。
- verify() 不重驗收據簽章（驗證函式不落盤）：完整性由鏈保證，有效性在入帳當下把關。

## 後果

R5 由 High 降為已處置（殘餘：self 白名單事由的節流仍靠 LocalCreditProvider 上限）。
Spec 001 的計價地基就緒。
