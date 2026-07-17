/**
 * WarmColdSignalingTransport — 傳輸選擇器（Spec 005 T3，三態連線模型）。
 *
 * 對 P2PConnectionManager 呈現單一 SignalingTransport，內部按 Spec 005 §4.1 選路：
 *
 *   send    → 有暖路徑（介紹人）？ 先走 warm（加密 peer 中繼，零伺服器）
 *             warm 無路/NACK/逾時 → 退回 cold（Firestore，韌性底線）並就此黏住
 *   receive → warm 與 cold 同時訂閱（對端選哪條都收得到；manager 以 signalId 去重）
 *
 * 「黏住 cold」：一次 warm 失敗代表這條 pair 目前無暖路徑（例如對方是全新 bootstrap
 * 的陌生人），其後的 trickle ICE 逐則再試 warm 只是重複 NACK 徒增延遲——黏住讓行為
 * 可預測；下一條連線（新 transport 實例）自然重新評估 warm。
 *
 * cold 延遲建立：只在真的用到（送/訂閱/清理）才向 coldFactory 要實例，預設工廠是
 * 動態 import 的 Firestore adapter → 本檔靜態圖無 firebase（對齊 manager.ensureSignaling）。
 */
import type { RawSignalDoc, SignalingTransport } from './SignalingTransport.types';
import { logger } from '../../utils/logger';

/**
 * 介紹加入的耐心設定（Spec 005 T4/T6）：對「經介紹加入」的對端，warm 第一次
 * NACK 很可能只是「介紹人還沒把他接進 mesh」——立刻退 Firestore 會讓被介紹者
 * 白寫 signaling。耐心窗內重試 warm；窗盡才退 cold。有界（不犧牲 liveness）：
 * 最壞多等 PATIENCE_MS 才走 cold，MeshConnection 30s ready timeout 內綽綽有餘。
 */
export interface WarmPatience {
  /** 這條 pair 是否適用耐心（對端是被介紹者／自己是被介紹者連非介紹人）。 */
  applies: () => Promise<boolean> | boolean;
  /** 耐心總窗（自 transport 建立起算）。 */
  totalMs: number;
  /** 每次重試間隔。 */
  retryDelayMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WarmColdSignalingTransport implements SignalingTransport {
  private cold: SignalingTransport | null = null;
  private coldPromise: Promise<SignalingTransport> | null = null;
  /** warm 失敗後黏住 cold（本 transport 實例生命週期內）。 */
  private stickCold = false;
  private readonly createdAt = Date.now();

  constructor(
    /** 加密 peer 中繼傳輸（PeerRelaySignalingTransport）；null＝這條 pair 無 warm 語義（純 cold）。 */
    private readonly warm: SignalingTransport | null,
    /** 韌性底線傳輸的延遲工廠（預設 Firestore；SDK 注入者可換自架）。 */
    private readonly coldFactory: () => Promise<SignalingTransport> | SignalingTransport,
    /** 現在是否有暖路徑可試（router.hasOpenNeighbors）。 */
    private readonly hasWarmPath: () => boolean,
    /** log 標注用。 */
    private readonly label: string,
    /** 介紹加入的耐心設定（可選；未給＝warm 一敗即退 cold）。 */
    private readonly patience?: WarmPatience
  ) {}

  private async ensureCold(): Promise<SignalingTransport> {
    if (this.cold) return this.cold;
    this.coldPromise ??= Promise.resolve(this.coldFactory()).then((t) => {
      this.cold = t;
      return t;
    });
    return this.coldPromise;
  }

  subscribe(cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void {
    // 兩路同訂：對端獨立做自己的 warm/cold 決策，收端必須兩邊都聽。
    // 重複遞送無害——manager 以 signalId 去重（warm 的 nsig-* 與 Firestore doc id 不同源不撞）。
    const unsubWarm = this.warm?.subscribe(cutoffMs, onAdded) ?? null;
    let unsubCold: (() => void) | null = null;
    let cancelled = false;
    void this.ensureCold()
      .then((cold) => {
        if (cancelled) return;
        unsubCold = cold.subscribe(cutoffMs, onAdded);
      })
      .catch((err) =>
        logger.warn('[WarmColdSignalingTransport] cold subscribe 失敗', { label: this.label, err })
      );
    return () => {
      cancelled = true;
      unsubWarm?.();
      unsubCold?.();
    };
  }

  async send(data: Record<string, unknown>): Promise<void> {
    if (this.warm && !this.stickCold && this.hasWarmPath()) {
      try {
        await this.warm.send(data);
        return;
      } catch (err) {
        // 介紹加入耐心窗：對被介紹的對端，NACK 可能只是介紹人還沒接上他——重試。
        if (this.patience && (await this.patience.applies())) {
          const deadline = this.createdAt + this.patience.totalMs;
          while (Date.now() < deadline) {
            await sleep(this.patience.retryDelayMs);
            if (!this.hasWarmPath()) continue;
            try {
              await this.warm.send(data);
              logger.info('[WarmColdSignalingTransport] warm 耐心重試成功', { label: this.label });
              return;
            } catch {
              /* 窗內繼續試 */
            }
          }
        }
        this.stickCold = true;
        logger.info('[WarmColdSignalingTransport] warm 無路，退回 cold（此 pair 黏住）', {
          label: this.label,
          reason: (err as Error).message,
        });
      }
    }
    await (await this.ensureCold()).send(data);
  }

  async cleanupOlderThan(beforeMs: number): Promise<void> {
    // warm 無此語義（no-op）；cold 只在已建立時清（別為清理特地建立 Firestore 連線）。
    if (this.cold) await this.cold.cleanupOlderThan(beforeMs);
  }

  async cleanupOwn(localUid: string): Promise<void> {
    if (this.cold) await this.cold.cleanupOwn(localUid);
  }
}
