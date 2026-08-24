/**
 * 房間內容金鑰協調器（ADR-0023 P2-②c）— keyx 分發的產生方側編排。
 *
 * 世界觀（ADR 修訂三）：內容金鑰本身是一筆日誌紀錄（channel:'keyx'）。本模組只負責
 * 「產生方」的決策與編排：誰產生、何時產生、封給誰、以 keyx 紀錄廣播。消費（開出封給
 * 自己的金鑰）在 GossipMessageHandler.consumeKeyx。純編排、無 live 連線細節，可獨立單測。
 *
 * 產生方選舉：在場（且已發布 ecdhPubKey）成員中 userId 字典序最小者。deterministic →
 * 同一名冊快照下全員算出同一產生方，避免多人同時各發一把金鑰。名冊來自共享的 Firestore
 * meshIdentities（最終一致）；形成期名冊可能瞬時不一致，收斂後穩定（見檔尾誠實邊界）。
 *
 * epoch：加人/移除（名冊變動）→ 產生方遞增 epoch + 新 keyx。epoch 取「本機已知最高
 * epoch + 1」→ 產生方交接時新 epoch 嚴格大於任何已流通者，配合「送出用最高 epoch」收斂。
 */

import { generateRoomKey, sealRoomKeyForAll } from './RoomKeyDistribution';
import { base64ToArrayBuffer } from '../../utils/crypto';
import type { KeyxRecordPayload } from '../../types';
import { logger } from '../../utils/logger';

export interface RoomKeyCoordinatorDeps {
  /** 本機 mesh userId（gossip senderId） */
  localUserId: string;
  /** 本機 ECDH 私鑰（成對封裝房間金鑰用） */
  getEcdhPrivateKey: () => CryptoKey;
  /** 本機 ECDH 公鑰 Base64 SPKI（內嵌 keyx 供收端 openSealedRoomKey） */
  getEcdhPublicKeyBase64: () => Promise<string>;
  /**
   * 載入名冊：members = 已註冊 mesh 身分者（含各自 ecdhPubKey），順序不拘；
   * participantCount = 房間 participants 人數（含尚未註冊身分者）。
   * 兩者用於「全員 ecdh 就緒」閘門，避免以殘缺名冊搶先分發（見 tick 註解）。
   */
  loadRoster: () => Promise<{
    members: Array<{ userId: string; ecdhPubKey?: string }>;
    participantCount: number;
  }>;
  /** 送出 keyx 紀錄（走 GossipMessageHandler.sendMessage 的 channel:'keyx'） */
  sendKeyx: (content: string) => Promise<void>;
  /** 安裝本機房間金鑰（產生方本來就持有明文金鑰，不需經 keyx 開） */
  applyLocalKey: (key: CryptoKey, epoch: number) => void;
  /** 本機金鑰環中已知最高 epoch（-1 = 尚無）；用於產生方交接時的 epoch 單調 */
  getMaxKnownEpoch: () => number;
  /**
   * store 是否已有他人紀錄（選填，Spec 018 交接寬限用；未提供＝false，
   * 行為與閘門加入前一致）。true 且未觀察到任何 keyx → 房間已運轉、既有 keyx
   * 可能在 anti-entropy 路上，延遲分發避免同代異鑰碰撞。
   */
  hasForeignRecords?: () => boolean;
  /**
   * store 中觀察到的最高 keyx epoch（選填，Spec 018；-1/未提供＝未見）。
   * 新加入者開不了舊 keyx（前向保密）但讀得到 epoch 明文 metadata；
   * 分發基底取 max(已安裝, 已觀察)+1，交接必單調。
   */
  getMaxObservedEpoch?: () => number;
}

/**
 * 名冊需連續穩定的 tick 數才分發（防形成期殘缺/瞬時不一致名冊搶先分發）。
 * 觀察到 sig 與上輪相同即 +1；達門檻才動作。與 4s tick 搭配 = 約 4-8s 穩定窗。
 */
const STABILITY_TICKS = 1;

/**
 * 交接寬限（Spec 018 第四道閘門）：金鑰環空但 store 已有他人紀錄時，延遲分發的
 * 最大 tick 數。4s tick × 3 ≈ 12s，涵蓋 anti-entropy 2s 週期數輪讓既有 keyx 到達；
 * 窗盡照發保 liveness。防的是「晚加入的新任 min-uid 未消費前任 keyx 即以 epoch 0
 * 再發」的跨時間交接碰撞（CI 7p 第五輪實證，Spec 016 殘留 E）。
 */
const HANDOVER_GRACE_TICKS = 3;

/**
 * 分發被擋住的原因（B5 可觀測性）。
 * 'none' 涵蓋「已分發」與「本節點非產生方」——兩者都不是異常，不需對使用者說明。
 */
export type KeyxBlockReason =
  | 'none'
  | 'self-not-in-roster' // 自己的 ecdh 身分尚未傳播到名冊
  | 'awaiting-members' // 有 participant 尚未註冊 ecdh 身分（B5 的殭屍情境）
  | 'roster-unstable' // 名冊仍在震盪，等連續穩定
  | 'handover-grace'; // Spec 018 交接寬限中

export interface KeyxStatus {
  reason: KeyxBlockReason;
  /** reason === 'awaiting-members' 時：還缺幾位尚未註冊身分 */
  pendingMembers: number;
  /** 目前這個原因已持續多久（毫秒）；none 為 0 */
  blockedForMs: number;
}

export class RoomKeyCoordinator {
  /** 上次分發所用的名冊簽章（userId 排序 join）；相同則不重發 */
  private distributedRosterSig: string | null = null;

  /**
   * 請求重新分發（Spec 022 C2）：同代異鑰衝突時由金鑰環回呼觸發。清掉冪等簽名，
   * 下一輪 tick 視同「名冊需要重發」，以 max(已知, 已觀察)+1 分發新 epoch 收斂全房。
   * 誰真的重發仍由既有三道閘門決定（本方法不繞過任何閘門）；請求頻率由金鑰環的
   * 每 epoch 去重＋每會話上限控制，此處不重複防護。
   */
  requestRedistribution(): void {
    this.distributedRosterSig = null;
  }
  /** 上輪觀察到的名冊簽章（穩定性判定） */
  private lastSeenSig: string | null = null;
  /** 名冊連續穩定計數（sig 與上輪相同則遞增，變動歸零） */
  private stableCount = 0;
  /** 交接寬限已延遲的 tick 數（Spec 018 閘門 4；窗盡不重置，liveness 有界） */
  private handoverWaitTicks = 0;

  /** 目前被哪道閘門擋住（B5 可觀測性；none = 未被擋） */
  private blockReason: KeyxBlockReason = 'none';
  /** blockReason 維持同一值的起始時間（毫秒）；換原因即重設 */
  private blockSince = 0;
  /** awaiting-members 時尚未註冊 ecdh 身分的人數 */
  private pendingMembers = 0;

  constructor(private deps: RoomKeyCoordinatorDeps) {}

  /**
   * B5：分發為何還沒發生。此前各道閘門只是靜默 return，一位 participant 遲遲不註冊
   * mesh 身分就能讓整房永遠等不到房間金鑰，60 秒後退成「必須確認明文」——
   * 而使用者完全看不出原因。這裡把狀態透出，讓上層能誠實說明還在等什麼。
   */
  getKeyxStatus(now: number = Date.now()): KeyxStatus {
    return {
      reason: this.blockReason,
      pendingMembers: this.pendingMembers,
      blockedForMs: this.blockReason === 'none' ? 0 : Math.max(0, now - this.blockSince),
    };
  }

  /** 記錄擋住的原因；同一原因持續時不重設起算點（才量得出「卡多久」）。 */
  private setBlock(reason: KeyxBlockReason, pendingMembers = 0, now: number = Date.now()): void {
    if (this.blockReason !== reason) {
      this.blockReason = reason;
      this.blockSince = now;
    }
    this.pendingMembers = pendingMembers;
  }

  /**
   * 週期評估並在需要時分發金鑰。冪等：同一穩定名冊多次呼叫只分發一次。
   * 非產生方為 no-op（純等 keyx 進來由 handler 消費）。任何一步失敗 → 記錄並留待下輪重試。
   *
   * 分發前三道閘門，共同確保「只有最終完整名冊的最小者」分發、避免雙產生方 epoch 碰撞：
   *  1. 全員 ecdh 就緒：eligible 人數 == participants 人數（有人尚未註冊身分 → 等）。
   *  2. 名冊穩定：連續數輪 sig 不變（濾掉形成期瞬時不一致的殘缺視圖）。
   *  3. 我是（穩定完整名冊的）最小 userId。
   */
  async tick(): Promise<void> {
    let members: Array<{ userId: string; ecdhPubKey?: string }>;
    let participantCount: number;
    try {
      const r = await this.deps.loadRoster();
      members = r.members;
      participantCount = r.participantCount;
    } catch (err) {
      logger.warn('[RoomKeyCoordinator] loadRoster failed', { err });
      return;
    }

    // 只考慮已發布 ecdhPubKey 的成員（其餘無法被封裝 → 不列入密文化）
    const eligible = members.filter(
      (m): m is { userId: string; ecdhPubKey: string } =>
        typeof m.userId === 'string' && typeof m.ecdhPubKey === 'string' && m.ecdhPubKey.length > 0
    );
    const ids = eligible.map((m) => m.userId);
    const sortedIds = [...ids].sort();
    const sig = sortedIds.join(',');

    // 名冊穩定性追蹤（在任何提前 return 前更新，確保穩定窗連續累計）
    if (sig === this.lastSeenSig) this.stableCount++;
    else { this.lastSeenSig = sig; this.stableCount = 0; }

    // 閘門 1：自己的 ecdhPubKey 尚未在名冊（傳播中）→ 等
    if (!ids.includes(this.deps.localUserId)) {
      this.setBlock('self-not-in-roster');
      return;
    }
    // 2 人以上才啟用密文化（只有自己 → 無對象可封，維持明文相容）
    if (eligible.length < 2) {
      this.setBlock('none'); // 單人房不是異常，不對使用者說明
      return;
    }
    // 閘門 1（續）：仍有 participant 未註冊 ecdh 身分 → 等全員就緒才分發，
    // 避免以殘缺名冊搶先分發（雙產生方 epoch 碰撞的主因）。
    // B5：這道閘門沒有逃生窗——一位遲遲不註冊的 participant 會讓整房停在這裡，
    // 故記錄原因與人數，讓上層說得出「還在等幾位」。
    if (participantCount > 0 && eligible.length < participantCount) {
      this.setBlock('awaiting-members', participantCount - eligible.length);
      return;
    }
    // 閘門 2：名冊尚未連續穩定 → 等（濾掉形成期瞬時不一致視圖）
    if (this.stableCount < STABILITY_TICKS) {
      this.setBlock('roster-unstable');
      return;
    }
    // 閘門 3：非（完整穩定名冊的）最小者 → 非產生方
    if (this.deps.localUserId !== sortedIds[0]) {
      this.setBlock('none'); // 非產生方是正常分工，不是被擋
      return;
    }

    if (sig === this.distributedRosterSig) {
      this.setBlock('none'); // 已分發
      return;
    }

    // 閘門 4（Spec 018）：交接寬限——環空、也未觀察到任何 keyx，但房間已運轉
    // → 等既有 keyx 抵達（開不開得了無所謂，epoch metadata 是明文）。
    // 一旦觀察到 keyx（或窗盡），以 max(已安裝, 已觀察)+1 分發，交接必單調。
    const observedEpoch = this.deps.getMaxObservedEpoch?.() ?? -1;
    if (
      this.deps.getMaxKnownEpoch() === -1 &&
      observedEpoch === -1 &&
      (this.deps.hasForeignRecords?.() ?? false) &&
      this.handoverWaitTicks < HANDOVER_GRACE_TICKS
    ) {
      this.handoverWaitTicks++;
      this.setBlock('handover-grace');
      logger.info('[RoomKeyCoordinator] handover grace — deferring distribution', {
        waitTick: this.handoverWaitTicks,
        graceTicks: HANDOVER_GRACE_TICKS,
      });
      return;
    }

    const epoch = Math.max(this.deps.getMaxKnownEpoch(), observedEpoch) + 1;
    try {
      const roomKey = await generateRoomKey();
      // 封給全體 eligible 含自己（Spec 017）：產生方重進後 hydrate 只能從自己 store 的
      // keyx 紀錄復原金鑰；不封給自己則回放靜默無效 → getMaxKnownEpoch()=-1 → 以 epoch 0
      // 重發新鑰，與對方手上同代舊鑰碰撞（rejoin flake 根因，10 輪 6 紅實證）。
      const sealTargets = await Promise.all(
        eligible.map(async (m) => ({
          userId: m.userId,
          ecdhPublic: await importEcdhPublic(m.ecdhPubKey),
        }))
      );
      const sealed = await sealRoomKeyForAll(
        roomKey,
        epoch,
        this.deps.getEcdhPrivateKey(),
        sealTargets
      );
      const payload: KeyxRecordPayload = {
        v: 'keyx1',
        producerEcdh: await this.deps.getEcdhPublicKeyBase64(),
        keys: sealed,
      };
      // 先廣播、後安裝本機：即便將來拿掉 keyx 免加密的保護，keyx content 也不會被自身金鑰加密
      await this.deps.sendKeyx(JSON.stringify(payload));
      this.deps.applyLocalKey(roomKey, epoch);
      this.distributedRosterSig = sig;
      this.setBlock('none'); // 分發成功 → 不再處於被擋狀態
      logger.info('[RoomKeyCoordinator] distributed keyx', {
        epoch,
        members: eligible.length - 1,
        rosterSize: eligible.length,
      });
    } catch (err) {
      // 分發失敗不推進 distributedRosterSig → 下輪重試
      logger.warn('[RoomKeyCoordinator] distribute failed; will retry next tick', { err });
    }
  }
}

/**
 * 由房間文件算出 keyx 名冊：**meshIdentities ∩ participants**。
 *
 * 關鍵：`RoomService.leaveRoom` 只縮 participants、不即時清 meshIdentities（離開者條目殘留）。
 * 若直接用 meshIdentities 當名冊，離開者會（a）續留名冊使 sig 不變 → 不觸發重發、
 * （b）被產生方繼續封鑰 → 無前向保密。故只認「仍在 participants 的成員」，離開即退出名冊
 * → 名冊縮小 → 新 epoch 新金鑰只封給留下者 → 離開者持舊 epoch 鑰、解不了新 epoch（前向保密）。
 */
export function rosterFromRoom(
  meshIdentities: Record<string, { userId: string; ecdhPubKey?: string }> | undefined,
  participants: string[] | undefined
): { members: Array<{ userId: string; ecdhPubKey?: string }>; participantCount: number } {
  const parts = new Set(participants ?? []);
  const members = Object.entries(meshIdentities ?? {})
    .filter(([firebaseUid]) => parts.has(firebaseUid))
    .map(([, v]) => ({ userId: v.userId, ecdhPubKey: v.ecdhPubKey }));
  return { members, participantCount: parts.size };
}

/** 匯入成員 ECDH 公鑰（Base64 SPKI）；公鑰無 key usages。 */
async function importEcdhPublic(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(b64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/*
 * 誠實邊界（P2-②c）：
 * - 雙產生方 epoch 碰撞（已修的主因）：形成期若以殘缺名冊搶先分發，兩個「各自視圖的最小者」
 *   可能各發一把 epoch-0 金鑰（不同鑰、同 epoch）→ 金鑰環相互覆蓋 → 解密失敗。三道閘門
 *   （全員 ecdh 就緒 + 名冊連續穩定 + 完整名冊最小者）令「只有最終完整名冊的最小者」分發，
 *   實務上消除此碰撞。理論殘留：Firestore 傳播延遲 > 穩定窗（數秒）造成的持久分裂視圖——
 *   極不可能且會在名冊收斂後自癒（新一輪以 getMaxKnownEpoch()+1 遞增 epoch，不再同號）。
 * - 移除成員的前向保密：以「名冊縮小 → 新 epoch 新金鑰」提供；被移除者持舊 epoch 鑰仍能解
 *   其在籍期間密文（符合 ADR「在籍期間可解」語義），無法解新 epoch。
 * - 混版房：有 participant 未發布 ecdhPubKey（舊 client）→ 閘門 1 永不滿足 → 該房維持明文相容。
 */
