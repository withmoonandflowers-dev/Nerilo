/**
 * warm/cold signaling 工廠的組裝邏輯（Spec 015 T1 抽出）。
 *
 * 原本這段寫死在 `MeshGossipManager.buildWarmColdFactory` 內，warm 需要的東西
 * （中繼匯流排、身分金鑰、對端公鑰解析、鄰居就緒判定）散在 manager 的私有欄位裡，
 * 第三方看不到也接不上。抽成一個吃 `WarmSignalingDeps` 的純組裝函式後：
 *
 * - mesh 照舊：manager 收集自己的內部狀態當 deps，行為一字不變
 *   （釘子 `tests/unit/MeshWarmColdFactory.spec.ts`）。
 * - SDK 可用：Spec 015 T3 的 `createWarmColdSignaling(deps)` 直接架在這上面。
 *
 * 刻意只吃**結構型別**（`SignalRelayBus`／`PeerKeyResolver` 等既有 interface），
 * 不吃 `SigRelayRouter`／`MeshGossipManager` 這類具體類別——否則公開表面會被
 * 內部實作綁死，違反 ADR-0025「只露最小穩定表面」。
 *
 * ⚠ warm 的真實前提（Spec 015 §4.1）：`relayBus` 是架在**既有鄰居 DataChannel**
 * 上的中繼。沒有跑 mesh 的消費者沒有這個底材，`hasWarmPath()` 恆 false，
 * 行為等同純 cold。這不是缺陷，是這條路徑的本質，文件不得含糊。
 */
import type { SignalingFactory, SignalingTransport } from './SignalingTransport.types';
import type {
  SignalRelayBus,
  LocalSignalIdentity,
  PeerKeyResolver,
  SignalClock,
} from './PeerRelaySignalingTransport';
import { PeerRelaySignalingTransport } from './PeerRelaySignalingTransport';
import { WarmColdSignalingTransport, type WarmPatience } from './WarmColdSignalingTransport';

/** warm signaling 需要的四件事，外加 cold 底線與耐心策略。 */
export interface WarmSignalingDeps {
  /** 本端 signaling 身分 id（進信封的 nodeId）。 */
  nodeId: string;
  /** 中繼匯流排：warm 經既有鄰居 DataChannel 轉送信封。 */
  relayBus: SignalRelayBus;
  /** 現在有沒有暖路徑可試（典型＝router.hasOpenNeighbors）。每次呼叫實時求值，不快取。 */
  hasWarmPath: () => boolean;
  /** 本端身分材料：ECDH 私鑰封信封、sign 簽章。 */
  identity: Omit<LocalSignalIdentity, 'nodeId'>;
  /** 對端公鑰解析（典型＝房間名冊）。 */
  peerKeys: PeerKeyResolver;
  /**
   * cold 底線傳輸工廠。未提供＝呼叫端沒有注入後端，由 `coldFallback` 決定；
   * 兩者皆無則這條 pair 只有 warm（極少見，通常代表設定錯誤）。
   */
  cold?: SignalingFactory;
  /** cold 未注入時的延遲預設（mesh 用它動態載入 Firestore adapter，維持入口零 firebase）。 */
  coldFallback?: (roomId: string, channelLabel: string) => Promise<SignalingTransport>;
  /**
   * 這條 pair 要不要對 warm 多等一會兒再退 cold（Spec 005 T4 介紹人耐心）。
   * 未提供＝不等，warm 一敗即退 cold。策略本身屬內部啟發式，不進公開契約。
   */
  patience?: {
    applies: (remoteUid: string) => Promise<boolean> | boolean;
    totalMs: number;
    retryDelayMs: number;
  };
  /** 時鐘與 nonce（測試可注入決定性來源）。省略＝真實時鐘 + crypto.randomUUID。 */
  clock?: SignalClock;
}

/**
 * 造一個 warm/cold 選擇器工廠。
 *
 * 呼叫端未帶 `remoteUid` 時封不了加密信封 → 該條 pair 無 warm 語義，回純 cold。
 * 這是既有行為，釘在 characterization 測試 C2。
 */
export function createWarmColdSignalingFactory(deps: WarmSignalingDeps): SignalingFactory {
  const clock: SignalClock = deps.clock ?? {
    now: () => Date.now(),
    nonce: () => crypto.randomUUID(),
  };

  return (roomId, channelLabel, remoteUid) => {
    const cold = () =>
      deps.cold
        ? deps.cold(roomId, channelLabel, remoteUid)
        : deps.coldFallback
          ? deps.coldFallback(roomId, channelLabel)
          : (() => {
              throw new Error('[warmCold] 既未注入 cold 也無 coldFallback，無韌性底線可退');
            })();

    if (!remoteUid) {
      return new WarmColdSignalingTransport(null, cold, () => false, channelLabel);
    }

    const warm = new PeerRelaySignalingTransport(
      deps.relayBus,
      { nodeId: deps.nodeId, ...deps.identity },
      deps.peerKeys,
      roomId,
      channelLabel,
      clock,
      remoteUid
    );

    const patience: WarmPatience | undefined = deps.patience && {
      applies: () => deps.patience!.applies(remoteUid),
      totalMs: deps.patience.totalMs,
      retryDelayMs: deps.patience.retryDelayMs,
    };

    return new WarmColdSignalingTransport(warm, cold, deps.hasWarmPath, channelLabel, patience);
  };
}
