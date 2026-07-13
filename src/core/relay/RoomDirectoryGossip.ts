/**
 * RoomDirectoryGossip — 公開房目錄的 P2P 廣播（去中心化大廳，第一片）
 *
 * 目的：公開房發現不再仰賴 Firestore 大廳查詢。dashboard 常駐節點之間已有
 * 陌生節點 relay 連線（P4-B），本模組在同一條 P2PChannelBus 上開 ns='roomdir'
 * （鏡像 courier 的掛載方式，零新傳輸）：連上即交換簽章房間廣告、之後週期重播；
 * 收端驗簽後進快取（同房取最新、TTL、容量帽），UI 直接讀快取。
 *
 * 信任模型（誠實邊界）：
 * - 廣告帶自我認證簽章（nodeId = hash(pubKey)，同 gossip 訊息模式）→ 防「冒名
 *   替別人發廣告」；不防「捏造自己名下的假房」——點進去 join 仍由 Firestore rules
 *   驗證，假房只是死連結。防洪靠 per-node 上限 + 快取總量帽 + TTL。
 * - Firestore 大廳仍是 bootstrap/fallback；本目錄是疊加的發現途徑，不是替代。
 */
import { ecdsaVerifier, pubKeyBindsNodeId } from './CourierReceipts';
import type { SignFn } from '../incentive/CoSignedReceipt';
import { logger } from '../../utils/logger';

export const ROOMDIR_NS = 'roomdir';
export const ROOMDIR_ANNOUNCE = 'ROOMDIR_ANNOUNCE';

/** 單次 announce 最多帶幾張廣告（防洪 + 封包大小） */
export const MAX_ADVERTS_PER_ANNOUNCE = 20;

export interface RoomAdvert {
  roomId: string;
  roomName: string;
  /** 房主 firebase uid（display/join 導向用；驗證發生在 join 時的 rules） */
  ownerUid: string;
  participantCount: number;
  issuedAt: number; // ms；同房以此取最新
  nodeId: string; // 廣告者 mesh 身分 = hash(pubKey)
  pubKey: string; // Base64 SPKI
  sig: string; // 簽在 canonical 字串上
}

/** 簽章覆蓋的欄位（固定順序拼接，無歧義） */
export function advertCanonical(ad: Omit<RoomAdvert, 'sig'>): string {
  return [
    ad.roomId,
    ad.roomName,
    ad.ownerUid,
    String(ad.participantCount),
    String(ad.issuedAt),
    ad.nodeId,
    ad.pubKey,
  ].join('\n');
}

export async function buildRoomAdvert(
  fields: Omit<RoomAdvert, 'sig'>,
  sign: SignFn
): Promise<RoomAdvert> {
  const sig = await sign(advertCanonical(fields));
  return { ...fields, sig };
}

/** 驗廣告：pubKey↔nodeId 綁定 + 簽章。壞形狀/壞簽章一律 false（fail-closed）。 */
export async function verifyRoomAdvert(ad: RoomAdvert): Promise<boolean> {
  if (
    !ad ||
    typeof ad.roomId !== 'string' ||
    ad.roomId.length === 0 ||
    ad.roomId.length > 128 ||
    typeof ad.roomName !== 'string' ||
    ad.roomName.length > 120 ||
    typeof ad.ownerUid !== 'string' ||
    typeof ad.participantCount !== 'number' ||
    typeof ad.issuedAt !== 'number' ||
    typeof ad.nodeId !== 'string' ||
    typeof ad.pubKey !== 'string' ||
    typeof ad.sig !== 'string'
  ) {
    return false;
  }
  try {
    if (!(await pubKeyBindsNodeId(ad.nodeId, ad.pubKey))) return false;
    const verify = await ecdsaVerifier(ad.pubKey);
    return await verify(advertCanonical(ad), ad.sig);
  } catch {
    return false;
  }
}

export interface RoomAdvertCacheOptions {
  ttlMs?: number; // 廣告新鮮視窗；預設 3 分鐘（announce 週期 60s 的 3 倍）
  maxTotal?: number; // 快取總量帽
  maxPerNode?: number; // 單一廣告者上限（防洪）
  now?: () => number; // 測試注入
}

/**
 * 廣告快取：同 roomId 取 issuedAt 最新（冪等、亂序收斂）、TTL 過期、容量帽。
 * 純狀態容器，不做網路與驗簽（驗簽在 attach 層，進來的都是已驗過的）。
 */
export class RoomAdvertCache {
  private byRoom = new Map<string, RoomAdvert>();
  private readonly ttlMs: number;
  private readonly maxTotal: number;
  private readonly maxPerNode: number;
  private readonly now: () => number;
  private changeListeners = new Set<() => void>();

  constructor(opts: RoomAdvertCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 3 * 60 * 1000;
    this.maxTotal = opts.maxTotal ?? 100;
    this.maxPerNode = opts.maxPerNode ?? MAX_ADVERTS_PER_ANNOUNCE;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 收錄一張（已驗簽的）廣告。回傳是否造成狀態改變。 */
  upsert(ad: RoomAdvert): boolean {
    const t = this.now();
    if (ad.issuedAt <= t - this.ttlMs) return false; // 到手即過期
    if (ad.issuedAt > t + 60_000) return false; // 未來時戳（>1min skew）拒收
    const existing = this.byRoom.get(ad.roomId);
    if (existing && existing.issuedAt >= ad.issuedAt) return false; // 非前進 → no-op

    if (!existing) {
      // per-node 防洪：同一廣告者的有效廣告數
      let fromNode = 0;
      for (const a of this.byRoom.values()) {
        if (a.nodeId === ad.nodeId) fromNode++;
      }
      if (fromNode >= this.maxPerNode) return false;
      // 總量帽：先修剪過期，仍滿則丟最舊的一張
      if (this.byRoom.size >= this.maxTotal) {
        this.prune();
        if (this.byRoom.size >= this.maxTotal) {
          let oldest: RoomAdvert | null = null;
          for (const a of this.byRoom.values()) {
            if (!oldest || a.issuedAt < oldest.issuedAt) oldest = a;
          }
          if (oldest && oldest.issuedAt < ad.issuedAt) this.byRoom.delete(oldest.roomId);
          else return false; // 進來的比快取裡最舊的還舊 → 不收
        }
      }
    }
    this.byRoom.set(ad.roomId, ad);
    this.changeListeners.forEach((l) => {
      try {
        l();
      } catch {
        /* listener 錯誤不影響快取 */
      }
    });
    return true;
  }

  /** 目前有效（未過期）的廣告，新的在前。 */
  list(): RoomAdvert[] {
    this.prune();
    return [...this.byRoom.values()].sort((a, b) => b.issuedAt - a.issuedAt);
  }

  /** 移除過期項。 */
  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [roomId, ad] of this.byRoom) {
      if (ad.issuedAt <= cutoff) this.byRoom.delete(roomId);
    }
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  size(): number {
    this.prune();
    return this.byRoom.size;
  }
}

/**
 * 組 announce 集合（多跳轉發）：自己的廣告優先，之後補上快取裡別人的（原簽轉發，
 * 下一跳仍可驗簽），同 roomId 以自己的為準，總量帽 cap。
 * 迴圈安全：轉發不改 issuedAt → 收端 upsert 冪等（非前進 no-op）+ TTL 界定壽命
 * + answer-once/週期界定頻率 → 不會震盪。
 */
export function mergeAnnounceSet(
  own: RoomAdvert[],
  cached: RoomAdvert[],
  cap: number = MAX_ADVERTS_PER_ANNOUNCE
): RoomAdvert[] {
  const out: RoomAdvert[] = [];
  const seen = new Set<string>();
  for (const ad of own) {
    if (seen.has(ad.roomId)) continue;
    seen.add(ad.roomId);
    out.push(ad);
    if (out.length >= cap) return out;
  }
  for (const ad of cached) {
    if (seen.has(ad.roomId)) continue;
    seen.add(ad.roomId);
    out.push(ad);
    if (out.length >= cap) return out;
  }
  return out;
}

// ── bus 掛載（鏡像 CourierService 的最小 bus 介面）──────────────────────────

interface RoomDirEnvelope {
  v: number;
  ns: string;
  type: string;
  id: string;
  ts: number;
  from: string;
  payload: unknown;
}

export interface RoomDirBus {
  subscribe(namespace: string, handler: (env: RoomDirEnvelope) => void | Promise<void>): () => void;
  send(env: RoomDirEnvelope): Promise<void>;
}

export interface AttachRoomDirectoryOptions {
  bus: RoomDirBus;
  cache: RoomAdvertCache;
  /** 本地要廣播的（已簽好的）廣告；attach 時與週期重播時各呼叫一次。 */
  getLocalAdverts: () => Promise<RoomAdvert[]>;
  localUid: string;
  /** 重播週期；預設 60s（快取 TTL 的 1/3）。0 = 不重播（只 attach 時廣播一次）。 */
  announceIntervalMs?: number;
}

/**
 * 把房間目錄協議掛上一條 relay bus：立即 announce 本地廣告、訂閱對方 announce
 * （逐張驗簽後入快取）、週期重播。回傳 detach。對稱協議，兩端同碼。
 */
export function attachRoomDirectory(opts: AttachRoomDirectoryOptions): () => void {
  const { bus, cache, getLocalAdverts, localUid } = opts;
  const intervalMs = opts.announceIntervalMs ?? 60_000;

  // 首次聽到對方 announce 時回播一次：兩端 attach 有先後（listening 端在 bus 開啟
  // 即掛，outbound 端稍晚），先掛者的初次 announce 會落空；回播讓交換與掛載順序無關。
  // 收斂性：answered 旗標保證每端至多回一次，不迴圈。
  let answered = false;

  const unsub = bus.subscribe(ROOMDIR_NS, async (env) => {
    if (env.type !== ROOMDIR_ANNOUNCE) return;
    const adverts = (env.payload as { adverts?: unknown })?.adverts;
    if (!Array.isArray(adverts)) return;
    for (const raw of adverts.slice(0, MAX_ADVERTS_PER_ANNOUNCE)) {
      const ad = raw as RoomAdvert;
      if (await verifyRoomAdvert(ad)) cache.upsert(ad);
      // 壞簽章靜默丟棄；量大時的節流交給 per-node 帽
    }
    if (!answered) {
      answered = true;
      void announce();
    }
  });

  const announce = async () => {
    try {
      const adverts = (await getLocalAdverts()).slice(0, MAX_ADVERTS_PER_ANNOUNCE);
      if (adverts.length === 0) return;
      await bus.send({
        v: 1,
        ns: ROOMDIR_NS,
        type: ROOMDIR_ANNOUNCE,
        id: `rd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        from: localUid,
        payload: { adverts },
      });
    } catch (err) {
      logger.debug?.('[RoomDirectoryGossip] announce failed (best-effort)', { err });
    }
  };

  void announce();
  const timer = intervalMs > 0 ? setInterval(() => void announce(), intervalMs) : null;

  return () => {
    unsub();
    if (timer) clearInterval(timer);
  };
}
