/**
 * CourierStore — 盲信使的有界密文儲存（ADR-0024 / ADR-0023 P4-C）
 *
 * 盲信使＝非成員為他人房間保存「密文」紀錄複本、待成員回線經 anti-entropy 補齊。
 * 本模組是信使儲存的經濟學核心（ADR-0024 全部決策）：存完整密文（非 hash，否則補不回）、
 * 配額（單筆/單房/總預算）、TTL、預算 LRU（淘汰最久未存取的房）、簽章墓碑刪除。
 *
 * 盲性：紀錄的 content 是密文信封（RecordCrypto），信使解不開；但 signature 涵蓋 content，
 * 信使改任何 byte 收端驗簽即失敗 → 存得、驗得、竄改不得。故此層不碰明文、不碰金鑰。
 *
 * 快取語義（ADR-0024 Decision 2）：權威複本永遠在成員本地（P1）；信使丟資料只降可用性、
 * 不損正確性 → 敢用小預算 + 激進淘汰。最壞情況＝沒有信使＝回到成員互補的 P1 現況。
 *
 * 純邏輯、無 I/O、無 WebRTC：時間由 now 注入、墓碑驗證由 verifyTombstone 注入 →
 * 可決定性單元/性質測試完整涵蓋。寄存/補齊的通道接線（跑在 P4-B relay DataChannel 上）
 * 與共簽收據計量（ADR-0022）屬後續（P4-C.2 / P4-D）。
 */

import type { GossipMessage } from '../../types';

/** ADR-0024 Decision 2 的預設配額（可調總預算 0/50/100/500 MB）。 */
export interface CourierStoreConfig {
  /** 單筆紀錄位元組上限（超過即拒；ADR-0024：4 KB，對齊固定封包）。 */
  maxRecordBytes: number;
  /** 單房位元組上限（ADR-0024：5 MB ≈ 活躍房 50 天文字量）。 */
  maxRoomBytes: number;
  /** 信使總預算（ADR-0024：預設 100 MB；設 0 = 不參與）。 */
  totalBudgetBytes: number;
  /** 保存視窗 TTL 毫秒（ADR-0024：14 天）。 */
  ttlMs: number;
}

export const DEFAULT_COURIER_CONFIG: CourierStoreConfig = {
  maxRecordBytes: 4 * 1024,
  maxRoomBytes: 5 * 1024 * 1024,
  totalBudgetBytes: 100 * 1024 * 1024,
  ttlMs: 14 * 24 * 60 * 60 * 1000,
};

/** deposit 結果——被拒時帶原因（供計量/診斷；ADR-0022 收據只對「已存」發）。 */
export type DepositResult =
  | { accepted: true; bytes: number }
  | { accepted: false; reason: 'budget-zero' | 'record-too-large' | 'duplicate' | 'expired' };

interface StoredRecord {
  msg: GossipMessage;
  bytes: number;
  depositedAt: number;
}

interface RoomHoldings {
  /** senderId → (seq → 紀錄)。與 antiEntropy 的 store 形狀一致，供 digest 直接複用。 */
  senders: Map<string, Map<number, StoredRecord>>;
  bytes: number;
  /**
   * 最近一次「真實使用」（serve/pull）的時刻，供總預算 LRU 淘汰整房。
   * Spec 001 Q4：寄存不算使用、不刷新此值——否則攻擊者持續自我寄存即可
   * 永久保溫，把誠實房擠出快取。建房時取初值。
   */
  lastAccessedAt: number;
}

export interface CourierStats {
  totalBytes: number;
  roomCount: number;
  recordCount: number;
}

/** 一筆持久化紀錄的形狀（hydrate 用）。 */
export interface PersistedCourierRecord {
  roomId: string;
  msg: GossipMessage;
  depositedAt: number;
  bytes: number;
}

/**
 * 持久化 port（可選）。CourierStore 以記憶體為權威（快取語義，ADR-0024），此 port 只把
 * 增/刪鏡像到耐久層（IndexedDB），讓代管的密文跨 reload 存活。實作在 services 層（Dexie）；
 * 省略＝純記憶體，行為與加此層前完全一致。全部 best-effort：寫入失敗不影響記憶體權威。
 */
export interface CourierPersistence {
  putRecord(rec: PersistedCourierRecord): Promise<void>;
  deleteRecord(roomId: string, senderId: string, seq: number): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  loadAll(): Promise<PersistedCourierRecord[]>;
  clear(): Promise<void>;
}

/** 紀錄的儲存體積估算：content + signature 的 UTF-8 位元組（信封其餘欄位為小常數，忽略）。 */
export function recordBytes(msg: GossipMessage): number {
  // TextEncoder 在瀏覽器與 Node 皆有；避免 Buffer（Node-only）。
  const enc = new TextEncoder();
  return enc.encode(msg.content).length + enc.encode(msg.signature).length;
}

export class CourierStore {
  private readonly rooms = new Map<string, RoomHoldings>();
  private totalBytes = 0;
  /**
   * per-寄存者占用（Spec 001）：簽章身分（紀錄的 senderId，可驗簽的出處）→ 目前占用位元組。
   * 供上層做 per-身分配額/計價；與 totalBytes 同步增減（deposit/淘汰/TTL/墓碑/清空）。
   */
  private readonly bySigner = new Map<string, number>();

  /** 持久化寫入串鏈（best-effort，序列化避免競態）；flush() 可等寫入落定。 */
  private writeTail: Promise<void> = Promise.resolve();
  private persistenceHealthy = true;

  constructor(
    private readonly config: CourierStoreConfig = DEFAULT_COURIER_CONFIG,
    private readonly now: () => number = () => Date.now(),
    private readonly persistence?: CourierPersistence
  ) {}

  /** per-簽章身分占用增減；歸零即移除鍵（避免 map 無限膨脹）。 */
  private addSigner(senderId: string, delta: number): void {
    const next = (this.bySigner.get(senderId) ?? 0) + delta;
    if (next > 0) this.bySigner.set(senderId, next);
    else this.bySigner.delete(senderId);
  }

  /** 整房下架時的批次會計：把房內每筆按 senderId 扣回。 */
  private subtractRoomSigners(room: RoomHoldings): void {
    for (const [senderId, seqs] of room.senders) {
      let sum = 0;
      for (const rec of seqs.values()) sum += rec.bytes;
      this.addSigner(senderId, -sum);
    }
  }

  /** 某簽章身分目前的占用位元組（不存在＝0）。供上層配額/計價。 */
  signerUsage(senderId: string): number {
    return this.bySigner.get(senderId) ?? 0;
  }

  /** 全部簽章身分占用的快照（複本）。 */
  signerStats(): Map<string, number> {
    return new Map(this.bySigner);
  }

  /** 目前總預算占用率（擁擠定價用）；不參與時視為滿載，避免報出免費容量。 */
  utilization(): number {
    if (this.config.totalBudgetBytes <= 0) return 1;
    return Math.min(1, this.totalBytes / this.config.totalBudgetBytes);
  }

  /** 把一個持久化寫入排進串鏈（吞錯，不影響記憶體權威）。 */
  private persist(op: () => Promise<void>): void {
    if (!this.persistence) return;
    this.writeTail = this.writeTail.then(op).catch(() => {
      this.persistenceHealthy = false;
    });
  }

  /** 等所有排入的持久化寫入落定（測試/關頁前確保耐久）。 */
  async flush(): Promise<boolean> {
    await this.writeTail;
    return this.persistenceHealthy;
  }

  /**
   * 從耐久層載回代管紀錄（重載後呼叫一次）。逾 TTL 者略過並刪除；其餘重建記憶體 + 會計。
   * 冪等安全：只補記憶體沒有的 (roomId, senderId, seq)（first-write-wins）。
   */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    let all: PersistedCourierRecord[];
    try {
      all = await this.persistence.loadAll();
    } catch {
      return;
    }
    const cutoff = this.now() - this.config.ttlMs;
    for (const p of all) {
      if (p.depositedAt <= cutoff) {
        this.persist(() => this.persistence!.deleteRecord(p.roomId, p.msg.senderId, p.msg.seq));
        continue;
      }
      const room = this.rooms.get(p.roomId) ?? {
        senders: new Map<string, Map<number, StoredRecord>>(),
        bytes: 0,
        lastAccessedAt: this.now(),
      };
      let seqs = room.senders.get(p.msg.senderId);
      if (seqs?.has(p.msg.seq)) continue; // 記憶體已有 → 不覆寫
      if (!seqs) {
        seqs = new Map<number, StoredRecord>();
        room.senders.set(p.msg.senderId, seqs);
      }
      seqs.set(p.msg.seq, { msg: p.msg, bytes: p.bytes, depositedAt: p.depositedAt });
      room.bytes += p.bytes;
      this.rooms.set(p.roomId, room);
      this.totalBytes += p.bytes;
      this.addSigner(p.msg.senderId, p.bytes);
    }
  }

  /**
   * 寄存一筆密文紀錄。first-write-wins：同 (senderId, seq) 已存在則不覆寫
   * （ADR-0024 寄件人分叉的現況策略）。成功後依序守單房上限、總預算 LRU。
   */
  deposit(msg: GossipMessage): DepositResult {
    if (this.config.totalBudgetBytes <= 0) return { accepted: false, reason: 'budget-zero' };
    const bytes = recordBytes(msg);
    if (bytes > this.config.maxRecordBytes) return { accepted: false, reason: 'record-too-large' };

    const room = this.rooms.get(msg.roomId) ?? {
      senders: new Map<string, Map<number, StoredRecord>>(),
      bytes: 0,
      lastAccessedAt: this.now(),
    };
    let seqs = room.senders.get(msg.senderId);
    if (seqs?.has(msg.seq)) return { accepted: false, reason: 'duplicate' }; // first-write-wins

    if (!seqs) {
      seqs = new Map<number, StoredRecord>();
      room.senders.set(msg.senderId, seqs);
    }
    const depositedAt = this.now();
    seqs.set(msg.seq, { msg, bytes, depositedAt });
    room.bytes += bytes;
    // 寄存「不」刷新 lastAccessedAt（Spec 001 Q4）：只有 serve/pull 算真實使用
    this.rooms.set(msg.roomId, room);
    this.totalBytes += bytes;
    this.addSigner(msg.senderId, bytes);
    this.persist(() => this.persistence!.putRecord({ roomId: msg.roomId, msg, depositedAt, bytes }));

    this.enforceRoomCap(msg.roomId);
    this.enforceTotalBudget();
    return { accepted: true, bytes };
  }

  /** 房內是否已有 (senderId, seq)——供 anti-entropy 判斷 peer 缺哪筆。 */
  has(roomId: string, senderId: string, seq: number): boolean {
    return this.rooms.get(roomId)?.senders.get(senderId)?.has(seq) ?? false;
  }

  /**
   * 撤回單筆剛接受的寄存。供「紀錄已進記憶體，但經濟狀態無法耐久」時補償回滾；
   * 一併修正容量／寄存者會計與耐久鏡像。不存在時為 no-op。
   */
  removeRecord(roomId: string, senderId: string, seq: number): boolean {
    const room = this.rooms.get(roomId);
    const seqs = room?.senders.get(senderId);
    const record = seqs?.get(seq);
    if (!room || !seqs || !record) return false;
    seqs.delete(seq);
    if (seqs.size === 0) room.senders.delete(senderId);
    if (room.senders.size === 0) this.rooms.delete(roomId);
    room.bytes -= record.bytes;
    this.totalBytes -= record.bytes;
    this.addSigner(senderId, -record.bytes);
    this.persist(() => this.persistence!.deleteRecord(roomId, senderId, seq));
    return true;
  }

  /**
   * 取一房的全部密文紀錄（供補齊/anti-entropy serve-back）。標記房被存取（LRU 保鮮）。
   * 回傳前先清一次過期，確保不吐已逾 TTL 的紀錄。
   */
  serveRoom(roomId: string): GossipMessage[] {
    this.evictExpired();
    const room = this.rooms.get(roomId);
    if (!room) return [];
    room.lastAccessedAt = this.now();
    const out: GossipMessage[] = [];
    for (const seqs of room.senders.values()) {
      for (const rec of seqs.values()) out.push(rec.msg);
    }
    return out;
  }

  /**
   * 房的 anti-entropy store 視圖：Map<senderId, Map<seq, GossipMessage>>。
   * 形狀與 antiEntropy.computeDigest 期望一致，可直接餵入算 digest。不改 LRU 時刻。
   */
  roomStore(roomId: string): Map<string, Map<number, GossipMessage>> {
    const view = new Map<string, Map<number, GossipMessage>>();
    const room = this.rooms.get(roomId);
    if (!room) return view;
    for (const [senderId, seqs] of room.senders) {
      const inner = new Map<number, GossipMessage>();
      for (const [seq, rec] of seqs) inner.set(seq, rec.msg);
      view.set(senderId, inner);
    }
    return view;
  }

  /**
   * 簽章墓碑刪除（ADR-0024 Decision 3.3）：房真刪／成員退出時，成員以房籍身分簽 tombstone；
   * 信使驗章即刪。驗證（pubKey + 房籍證明）由外部注入的 verify 完成——本層盲，只管刪。
   * @returns 釋放的位元組數（0 表示驗證未過或房不存在）。
   */
  async applyTombstone(
    roomId: string,
    verify: () => boolean | Promise<boolean>
  ): Promise<number> {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    if (!(await verify())) return 0;
    const freed = room.bytes;
    this.rooms.delete(roomId);
    this.totalBytes -= freed;
    this.subtractRoomSigners(room);
    this.persist(() => this.persistence!.deleteRoom(roomId));
    return freed;
  }

  /** 使用者主權（ADR-0024 Decision 3.4）：手動清空全部代存。 */
  clearAll(): void {
    this.rooms.clear();
    this.totalBytes = 0;
    this.bySigner.clear();
    this.persist(() => this.persistence!.clear());
  }

  /** TTL 過期清除（ADR-0024 Decision 3.1）。回傳清掉的紀錄數。 */
  evictExpired(): number {
    const cutoff = this.now() - this.config.ttlMs;
    let removed = 0;
    for (const [roomId, room] of this.rooms) {
      for (const [senderId, seqs] of room.senders) {
        for (const [seq, rec] of seqs) {
          if (rec.depositedAt <= cutoff) {
            seqs.delete(seq);
            room.bytes -= rec.bytes;
            this.totalBytes -= rec.bytes;
            this.addSigner(senderId, -rec.bytes);
            this.persist(() => this.persistence!.deleteRecord(roomId, senderId, seq));
            removed++;
          }
        }
        if (seqs.size === 0) room.senders.delete(senderId);
      }
      if (room.senders.size === 0) this.rooms.delete(roomId);
    }
    return removed;
  }

  stats(): CourierStats {
    let recordCount = 0;
    for (const room of this.rooms.values()) {
      for (const seqs of room.senders.values()) recordCount += seqs.size;
    }
    return { totalBytes: this.totalBytes, roomCount: this.rooms.size, recordCount };
  }

  /** 單房超上限：淘汰該房最舊寄存的紀錄直到 ≤ 上限（房內 FIFO；快取語義下可接受）。 */
  private enforceRoomCap(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.bytes <= this.config.maxRoomBytes) return;
    const all: Array<{ senderId: string; seq: number; rec: StoredRecord }> = [];
    for (const [senderId, seqs] of room.senders) {
      for (const [seq, rec] of seqs) all.push({ senderId, seq, rec });
    }
    all.sort((a, b) => a.rec.depositedAt - b.rec.depositedAt); // 最舊在前
    for (const { senderId, seq, rec } of all) {
      if (room.bytes <= this.config.maxRoomBytes) break;
      const seqs = room.senders.get(senderId);
      seqs?.delete(seq);
      if (seqs && seqs.size === 0) room.senders.delete(senderId);
      room.bytes -= rec.bytes;
      this.totalBytes -= rec.bytes;
      this.addSigner(senderId, -rec.bytes);
      this.persist(() => this.persistence!.deleteRecord(roomId, senderId, seq));
    }
  }

  /** 總預算觸頂：淘汰最久未被存取的整房（ADR-0024 Decision 3.2 預算 LRU）。 */
  private enforceTotalBudget(): void {
    if (this.totalBytes <= this.config.totalBudgetBytes) return;
    const byLru = [...this.rooms.entries()].sort(
      (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
    ); // 最久未存取在前
    for (const [roomId, room] of byLru) {
      if (this.totalBytes <= this.config.totalBudgetBytes) break;
      this.rooms.delete(roomId);
      this.totalBytes -= room.bytes;
      this.subtractRoomSigners(room);
      this.persist(() => this.persistence!.deleteRoom(roomId));
    }
  }
}
