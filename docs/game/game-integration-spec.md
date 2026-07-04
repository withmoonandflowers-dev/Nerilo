# 遊戲整合規格：在 Nerilo 上做一個小型多人遊戲

> 給要用 Nerilo 當遊戲底層的開發者（你自己）。前提：小型合作/回合制（ADR-G01）。
> 對齊 docs/INTEGRATION-SPEC.md，聚焦遊戲場景。成熟度見每節。

## 0. 你要做的 vs Nerilo 給的

| 你寫 | Nerilo 給 |
|---|---|
| 遊戲規則、勝負判定、渲染、輸入 | 把 bytes 安全送達對端（可靠+不可靠雙通道） |
| 配對/大廳（可借 Firebase auth + 房間） | 成員名冊、seed 協商、房主接替 |
| （若需要）反作弊 | 二進位編碼、版本協商、NAT 穿透、重連 |

## 1. 選你的同步模型（先決定這個）

| 模型 | 適合 | 走哪條通道 |
|---|---|---|
| **事件式**（送「發生了什麼」） | 回合制、慢節奏（棋/卡牌） | 可靠控制通道 |
| **Lockstep**（送輸入，雙方同步推進） | RTS、確定性合作 | 可靠控制通道 + seed |
| **狀態同步**（送位置/狀態幀） | 即時動作（casual） | 不可靠狀態通道 |

回合制最簡單，從這開始。

## 2. 事件式（回合制）　`成熟度：穩定`

```ts
const bus = p2pManager.getChannelBus()!;
const MY_NS = 'ttt'; // 你的遊戲代號，自己取

// 收對手動作
bus.subscribe(MY_NS, (env) => {
  if (env.type === 'MOVE') applyOpponentMove(env.payload);
  if (env.type === 'RESTART') resetBoard();
});

// 送自己動作
async function play(cell: number) {
  applyMyMove(cell);              // 先本地更新（樂觀）
  await bus.send({
    v: 1, ns: MY_NS, type: 'MOVE',
    id: crypto.randomUUID(), ts: Date.now(), from: myId,
    payload: { cell },
  });
}
```

要點：可靠有序 + E2EE 自動。payload 是你自定的任意 JSON。

## 3. 狀態同步（即時 casual）　`成熟度：Beta（state 通道 2 人星型已接）`

```ts
import { defineComponent, f32, defineStateFrame, createFrameGate } from '@/core/game/sdk';

const Pos = defineComponent('p', { x: f32, y: f32 });
const Frame = defineStateFrame(Pos);
const gate = createFrameGate();
const sc = p2pManager.getStateChannel();

// 送（每幀，未 open 自動丟）
sc?.send(Frame.encode(seq++, rosterVer, { x: me.x, y: me.y }));

// 收（丟 stale 幀）
sc?.onFrame((bytes) => {
  const f = Frame.decode(bytes);
  if (!gate.accept(f.seq)) return;
  peer.x = f.data.x; peer.y = f.data.y;
});
```

要點：不可靠、丟幀天然覆蓋、不做 E2EE（DTLS 已加密）、禁走 Firestore fallback。
丟幀的視覺跳變要你自己插值/預測（遊戲層）。

## 4. 名冊 / seed / 房主接替　`成熟度：SDK 已備`

用 `GameSession`（`src/core/game/sdk/GameSession.ts`）拿：誰在場、確定性 seed
（hash-then-reveal 防作弊）、房主斷線自動接替。lockstep 必用同一 seed 才能同步。

## 5. 版本相容（防 desync）　`成熟度：穩定`

宣告 `strictProtocols: { ttt: 1 }`。雙方版本不等會被擋並提示更新——遊戲規則/
狀態格式一改就升版號，避免新舊 client 對戰 desync。

## 6. 硬限制（別踩，ADR-G01）

- **不能防競技作弊**：對端能改自己 client；state-hash 只擋 casual desync。→ 合作/朋友間。
- **2~5 人**：星型 2 人最穩，mesh 3~5 可，6+ 未接線。
- **同區域優先**：跨區 200ms+ 慢節奏才扛得住。
- **少數連不上**：NAT 受阻約 8~15%，接受或自備 TURN。
- **你是第一個真實使用者**：SDK 沒跑過真實遊戲，會有整合 bug，回報。

## 7. 最小可玩里程碑（建議順序）

1. 2 人回合制（事件式，第 2 節）——證明「連線 → 出招 → 對方看到」整條通。
2. 加房主接替 + 重連（斷線不崩）。
3. 若要即時：換狀態同步（第 3 節）+ 插值。
4. 配對/大廳（借 Firebase auth + p2pRooms）。

先做 1，那是你第一次看到「遊戲真的跑在 Nerilo 上」。
