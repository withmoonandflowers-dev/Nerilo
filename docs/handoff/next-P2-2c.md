# 下一步：ADR-0023 P2-②c — keyx 接進 live mesh（3-5 人房真 E2EE）

> 在乾淨、低負載的新 session 開這步（mesh E2E 對機器負載敏感）。

## 先讀
1. docs/adr/0023-room-as-replicated-log.md（修訂三：金鑰分發設計 + P2 三階段表）
2. 已完成的隔離模組（皆測試通過）：
   - src/core/mesh/RecordCrypto.ts（單一密文信封，簽章覆蓋密文）
   - src/core/mesh/RoomKeyDistribution.ts（成對 ECDH 封裝 = keyx）
   - src/core/mesh/GossipMessageHandler.ts setContentKey/加解密（P2-②a，金鑰為閘、無鑰退明文）

## 鐵律：先叫 harden-tests skill
動 live mesh 前先 `/harden-tests`。釘子＝tests/e2e-vue/mesh-diagnostic.spec.ts。
逐層：L0 type-check → L1 受影響單元 → L2 全單元(含 npm run test:coverage 門檻) → L3 mesh-diagnostic 連跑 3 次。
釘子紅→git stash 到 baseline 分辨「我的迴歸」vs「環境 flaky」，不硬改。

## 接線（MeshGossipManager 為主）
1. 成員發布 ECDH 公鑰（meshIdentities 現只存 ECDSA 簽章鑰）：擴充 meshIdentities 加 ecdhPubKey，或 gossip announce 廣播。選低風險者、ADR 記錄決策。
2. keyx 走 gossip：金鑰產生方（uid 字典序最小在場者，deterministic）用 sealRoomKeyForAll 封給全員，channel:'keyx' 寫進 gossip 管線（同一條對帳，遲入/重進靠 anti-entropy 補齊）。
3. 消費 keyx：收到 channel:'keyx' 且 forMember==自己 → openSealedRoomKey → setContentKey(key,epoch)。keyx 不進聊天顯示（如 game 通道分流）。
4. epoch：加人/移除遞增 epoch + 新 keyx；解密端按信封 epoch 選鑰（②a 已支援）。
5. 「金鑰未就緒退明文相容」不得破壞。

## 驗收
- 新 E2E：3 人房發訊 → wire 上密文、UI 明文；盲信使（第4人掛 home）存到密文、解不開。
- mesh-diagnostic 連跑 3 次全綠。全單元+覆蓋率門檻綠；有意義提升就上調地板。

## 範圍界線
- 只做 mesh 房密文化。2人房切 gossip/star 退役＝P2-③，不在此。
- React 生產(src/features, tests/e2e)不動；動 @legacy core 要跑 tests/e2e/mesh-diagnostic.spec.ts 護欄。
- mesh-rejoin 負載 flaky＝非迴歸（連線碼自 P1 未動）；低負載仍 flaky 再另查。
