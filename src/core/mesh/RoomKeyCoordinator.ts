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
}

/**
 * 名冊需連續穩定的 tick 數才分發（防形成期殘缺/瞬時不一致名冊搶先分發）。
 * 觀察到 sig 與上輪相同即 +1；達門檻才動作。與 4s tick 搭配 = 約 4-8s 穩定窗。
 */
const STABILITY_TICKS = 1;

export class RoomKeyCoordinator {
  /** 上次分發所用的名冊簽章（userId 排序 join）；相同則不重發 */
  private distributedRosterSig: string | null = null;
  /** 上輪觀察到的名冊簽章（穩定性判定） */
  private lastSeenSig: string | null = null;
  /** 名冊連續穩定計數（sig 與上輪相同則遞增，變動歸零） */
  private stableCount = 0;

  constructor(private deps: RoomKeyCoordinatorDeps) {}

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
    if (!ids.includes(this.deps.localUserId)) return;
    // 2 人以上才啟用密文化（只有自己 → 無對象可封，維持明文相容）
    if (eligible.length < 2) return;
    // 閘門 1（續）：仍有 participant 未註冊 ecdh 身分 → 等全員就緒才分發，
    // 避免以殘缺名冊搶先分發（雙產生方 epoch 碰撞的主因）
    if (participantCount > 0 && eligible.length < participantCount) return;
    // 閘門 2：名冊尚未連續穩定 → 等（濾掉形成期瞬時不一致視圖）
    if (this.stableCount < STABILITY_TICKS) return;
    // 閘門 3：非（完整穩定名冊的）最小者 → 非產生方
    if (this.deps.localUserId !== sortedIds[0]) return;

    if (sig === this.distributedRosterSig) return; // 此名冊已分發

    const epoch = this.deps.getMaxKnownEpoch() + 1;
    try {
      const roomKey = await generateRoomKey();
      const others = eligible.filter((m) => m.userId !== this.deps.localUserId);
      const sealTargets = await Promise.all(
        others.map(async (m) => ({
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
      logger.info('[RoomKeyCoordinator] distributed keyx', {
        epoch,
        members: others.length,
        rosterSize: eligible.length,
      });
    } catch (err) {
      // 分發失敗不推進 distributedRosterSig → 下輪重試
      logger.warn('[RoomKeyCoordinator] distribute failed; will retry next tick', { err });
    }
  }
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
