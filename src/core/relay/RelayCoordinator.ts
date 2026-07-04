/**
 * RelayCoordinator — 把「中繼路由大腦」接到真實系統的整合層（ADR-0021）
 *
 * ⚠️ 誠實邊界：RelayManager 是完整的路由大腦，但它路由的「全域 relay overlay」
 *   （陌生節點宣告可中繼 → 被發現 → 被連上）**尚未建立**。本 Coordinator 做兩件
 *   現在就真實可用、可測的事，其餘（overlay 發現層、跨房傳輸、多節點驗證）待建：
 *
 *   1. 中繼賺點 → 真實餘額：把 RelayManager 內部的 'relay:credit-earned' 事件
 *      轉進 CreditEconomy（使用者看得到的餘額）。這讓「中繼即價值」真正接通——
 *      一旦中繼實際運作，點數就流進真實帳本，而非 RelayManager 的孤立內部帳。
 *
 *   2. 傳輸注入接縫：attachTransport() 讓 overlay 就緒後注入「送給任一 peer」的
 *      能力與訊息遞交回呼。在 overlay 存在前，這個接縫閒置（不路由到不存在的網路）。
 */

import type { RelayManager, PeerSendFn, MessageDeliveryFn } from './RelayManager';
import type { CreditEconomy } from '../incentive/CreditEconomy';
import { logger } from '../../utils/logger';

export class RelayCoordinator {
  private unsubscribers: (() => void)[] = [];
  private transportAttached = false;

  constructor(
    private readonly relay: RelayManager,
    private readonly credits: CreditEconomy
  ) {}

  /** 開始把中繼賺點事件轉進真實餘額。 */
  start(): void {
    const unsub = this.relay.on('relay:credit-earned', (event) => {
      const bytes = typeof event.data.bytes === 'number' ? event.data.bytes : 0;
      if (bytes <= 0) return;
      // requester 用稽核佔位；Nerilo 只在意「本機為他人轉發了 N bytes → 產生點數」
      void this.credits.recordRelayContribution('relay-peer', bytes).catch((err) => {
        logger.warn('[RelayCoordinator] recordRelayContribution failed', { err });
      });
    });
    this.unsubscribers.push(unsub);
  }

  /**
   * 注入真實傳輸（全域 relay overlay 就緒後呼叫）。
   * @param peerSend 送 raw data 給指定 peer（實際 WebRTC 送）
   * @param onDelivery 中繼訊息組裝完成後遞交給應用
   */
  attachTransport(peerSend: PeerSendFn, onDelivery: MessageDeliveryFn): void {
    this.relay.setPeerSendFunction(peerSend);
    this.relay.onMessageDelivery(onDelivery);
    this.transportAttached = true;
    logger.info('[RelayCoordinator] transport attached');
  }

  /** overlay/傳輸是否已接（未接時中繼無法實際送達，僅計費事件可運作） */
  isTransportAttached(): boolean {
    return this.transportAttached;
  }

  stop(): void {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
  }
}
