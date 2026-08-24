/**
 * Nerilo SDK — Firestore turnkey 工廠出口（subpath：`nerilo/firestore`）。
 *
 * 這裡是唯一動態載入 `MeshChatService` 的地方，故本入口的型別圖含 mesh/crypto。想要「純注入、零 Firebase 型別」的消費者請改用主入口 `nerilo`
 * （NeriloClient + ports + InMemory 參考實作 + 純 reducer），本檔留給要 turnkey 的人。
 *
 * 架構收斂 2026-07：把重型工廠從主 barrel 拆出，讓 `nerilo` 的公開型別表面乾淨。
 */
import { NeriloClient } from './NeriloClient';
import type { IChatEngine } from './IChatEngine';
import type { SignalingFactory } from '../core/p2p/SignalingTransport.types';
import { createLazySignalingTransport } from '../core/p2p/lazySignalingTransport';
import { createWarmColdSignalingFactory } from '../core/p2p/warmColdSignalingFactory';
import type { SignalRelayBus, PeerKeyResolver } from '../core/p2p/PeerRelaySignalingTransport';
import type { SignFn, SignalEnvelope } from '../core/p2p/SignalEnvelope';
import type { IRoomDirectory, IChatStorage, IRoomCatalog, CatalogRoom } from '../ports';

// warm 後端的實作者需要這些型別來寫自己的 relayBus / peerKeys（Spec 015 T3）。
// 信封本身是不透明的：中繼只依 `to` 轉密文，不解讀內容。
export type { SignalRelayBus, PeerKeyResolver, SignalEnvelope, SignFn };

/**
 * 通用工廠：建一個 NeriloClient。三個後端全可注入（signaling / directory / storage）。
 * 省略者延到 initialize() 才動態載入預設 Firestore/IndexedDB —— 故全部注入時，這條建構路徑
 * 的靜態相依圖無 Firebase（見 sdkSurface 測試；MeshChatService 圖已 0 firebase）。
 */
export async function createChatClient(config: {
  roomId: string;
  userId: string;
  signaling?: SignalingFactory; // 省略＝Firestore（延遲）
  directory?: IRoomDirectory;   // 省略＝Firestore（延遲）
  storage?: IChatStorage;       // 省略＝IndexedDB（瀏覽器）
}): Promise<NeriloClient> {
  // Spec 013 的已知殘留已於 2026-07-26 收斂：MeshChatService 已搬進 core/messaging，
  // SDK 不再有任何路徑（含動態 import）穿過 src/features。由
  // tests/unit/fitness.architecture.spec.ts 的動態 import 檢查釘住。
  const { MeshChatService } = await import('../core/messaging/MeshChatService');
  const engine: IChatEngine = new MeshChatService(
    config.roomId, config.userId, config.storage, config.signaling, config.directory
  );
  return new NeriloClient(engine);
}

/**
 * Firestore signaling 工廠（Spec 015 T2）——只要牽線、不要整個聊天客戶端的人用這個。
 *
 * 情境：第三方已經有自己的 P2P 應用（遊戲、協作白板），只缺一套「交換 SDP/ICE」的
 * 後端。在此之前 SDK 只公開 `SignalingTransport` **介面**，實作得自己寫一份；
 * Nerilo 明明有一份跑在 production 的卻拿不到（block-brawl 2026-07-25 實測撞到）。
 *
 * **使用前提（2026-07-26 實測確認，勿當作純選配）**：讀寫 `p2pRooms/{roomId}/signals`
 * 的 rules 要求呼叫者在該房 `participants` 內，而建房又要求非匿名帳號
 * （`firestore.rules:144`、`:198-204`）。因此目前**只有已採用 Nerilo 房間模型的應用**
 * 能用它；純匿名情境（例如遊戲大廳）還缺一個輕量建房／目錄契約（Spec 014，未實作）。
 * 詳見 Spec 015 的 T6。
 *
 * 誠實邊界（憲法第 10 條，勿刪）：
 * - 這條通道傳的是 SDP/ICE，**不是**訊息內容；它不提供端到端加密。
 * - 內容對你的 Firestore 後端可見。
 * - SDP 尚未簽章（GOAL-ANALYSIS GS2 未做，風險登記 R9）：signaling 的完整性邊界
 *   是你自己的 Firebase auth/rules，不是密碼學。
 *
 * 需自備 Firebase 專案與對應 rules／索引，見 docs/SDK-QUICKSTART.md。
 */
export function createFirestoreSignaling(): SignalingFactory {
  return (roomId, channelLabel) =>
    createLazySignalingTransport(async () => {
      // 動態載入：主入口 `nerilo` 的 eager 圖不得靜態帶進 firebase（qa:sdk-isolation 硬閘）。
      const m = await import('../core/p2p/SignalingTransport');
      return new m.RoomSignalingTransport(roomId, channelLabel);
    });
}

/**
 * warm 中繼 signaling 的後端（Spec 015 T3）。
 *
 * **先讀這段再決定要不要用**：warm 不是一個可以獨立安裝的傳輸，它是架在**你已經有的
 * mesh 鄰居連線**上的中繼——`relayBus` 得把信封送進那些連線，`hasWarmPath()` 回報
 * 現在有沒有連線可用。沒有 mesh 就沒有這個底材，`hasWarmPath()` 恆 false，
 * 整條路徑等同純 cold。這種情況請直接用 `createFirestoreSignaling()`，不要繞這裡。
 *
 * 有 mesh 時的收益：新成員的 signaling 走既有鄰居加密轉送，不落伺服器
 * （「第三人零 Firestore 寫入」，Spec 005）。
 */
export interface WarmSignalingBackend {
  /** 本端 signaling 身分 id（進信封的 nodeId）。 */
  nodeId: string;
  /** 中繼匯流排：把信封交給你的 mesh 遞送，並訂閱寄給自己的入站信封。 */
  relayBus: SignalRelayBus;
  /** 現在有沒有暖路徑可試。每次呼叫實時求值。 */
  hasWarmPath: () => boolean;
  /** 本端身分材料。`epoch` 省略＝0（金鑰世代，供收端選鑰）。 */
  identity: { ecdhPrivateKey: CryptoKey; epoch?: number; sign: SignFn };
  /** 對端公鑰解析（你的名冊）。 */
  peerKeys: PeerKeyResolver;
  /**
   * 對特定對端多等一會兒 warm 再退 cold。省略＝warm 一敗即退。
   * 這是內部啟發式的注入點，語義可能隨版本調整，不建議依賴細節。
   */
  patience?: {
    applies: (remoteUid: string) => Promise<boolean> | boolean;
    totalMs: number;
    retryDelayMs: number;
  };
}

/**
 * 造一個 warm/cold signaling 工廠（Spec 015 T3）。
 *
 * **省略 `warm` 時直接回傳 cold 工廠本身**——不是包一層看起來像 warm 的殼。
 * 這是刻意的：讓「沒有 mesh 就沒有 warm」在程式上是可驗證的事實，而不是文件上的
 * 但書（驗收 V2 有測試釘住這個等價）。
 */
export function createWarmColdSignaling(
  options: { cold?: SignalingFactory; warm?: WarmSignalingBackend } = {}
): SignalingFactory {
  const cold = options.cold ?? createFirestoreSignaling();
  const warm = options.warm;
  if (!warm) return cold; // 明示退化：無 warm 後端＝就是 cold，不加殼

  return createWarmColdSignalingFactory({
    nodeId: warm.nodeId,
    relayBus: warm.relayBus,
    hasWarmPath: warm.hasWarmPath,
    identity: {
      ecdhPrivateKey: warm.identity.ecdhPrivateKey,
      epoch: warm.identity.epoch ?? 0,
      sign: warm.identity.sign,
    },
    peerKeys: warm.peerKeys,
    cold,
    patience: warm.patience,
  });
}

/**
 * Firestore 房間目錄（Spec 014 T3）——包既有 production 路徑，不另開寫入面：
 *  - `list`：既有 `getPublicRooms`（status=='open' && isPrivate==false && TTL 未過，
 *    伺服器端過濾＋limit 20）。
 *  - `publish`：既有建房＋啟用（createRoom → activateRoom）。**id 由後端生成**，
 *    以回傳值為準（caller 給的 id 忽略，契約已明示）。
 *  - `unpublish`：既有 closeRoom；冪等（房不存在不拋）。
 *  - `watch`：**輪詢實作**（預設 15s，可調）。刻意不掛常駐 onSnapshot——2026-07-13
 *    配額事件後公開列表改一次性讀取（RoomService.ts:894 注記），SDK 不繞開該決策。
 *
 * 使用前提（誠實邊界，2026-08-24 拍板維持）：建房要求**非匿名帳號**（firestore.rules），
 * 匿名玩家可加入他人的房，但不能 publish。遊戲嵌入者要讓玩家開房，需先走登入。
 */
export function createFirestoreRoomCatalog(config: {
  uid: string;
  ownerName?: string;
  watchIntervalMs?: number;
}): IRoomCatalog {
  const interval = config.watchIntervalMs ?? 15_000;
  const svc = async () => (await import('../services/RoomService')).RoomService;

  const toCatalog = (r: {
    roomId: string; roomName?: string; participants: string[];
    ownerUid: string; ownerName?: string; createdAt: number; maxParticipants?: number;
  }): CatalogRoom => ({
    id: r.roomId,
    ...(r.roomName ? { name: r.roomName } : {}),
    occupancy: r.participants.length,
    ...(r.maxParticipants !== undefined ? { capacity: r.maxParticipants } : {}),
    meta: { ownerUid: r.ownerUid, ownerName: r.ownerName, createdAt: r.createdAt },
  });

  return {
    async list() {
      const S = await svc();
      return (await S.getPublicRooms()).map(toCatalog);
    },
    watch(onChange) {
      let last = '';
      let stopped = false;
      const tick = async (first: boolean) => {
        try {
          const S = await svc();
          const rooms = (await S.getPublicRooms()).map(toCatalog);
          const key = JSON.stringify(rooms);
          if (stopped) return;
          if (first || key !== last) {
            last = key;
            onChange(rooms);
          }
        } catch { /* 讀取失敗這輪跳過，下輪再試（對齊 getPublicRooms 的降級語義） */ }
      };
      void tick(true); // 訂閱當下先收一次
      const timer = setInterval(() => void tick(false), interval);
      return () => { stopped = true; clearInterval(timer); };
    },
    async publish(room) {
      const S = await svc();
      const roomId = await S.createRoom(
        config.uid, config.ownerName ?? null, /* isPrivate */ false, [config.uid],
        undefined, true, room.name, room.capacity
      );
      await S.activateRoom(roomId, config.uid); // waiting 房不進公開列表，公告＝直接啟用
      return roomId;
    },
    async unpublish(id) {
      const S = await svc();
      try {
        await S.closeRoom(id, config.uid);
      } catch (e) {
        if (e instanceof Error && e.message.includes('不存在')) return; // 冪等
        throw e;
      }
    },
  };
}

