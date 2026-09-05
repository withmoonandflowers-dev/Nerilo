/**
 * Spec 031 服務欠條在 courier namespace 上的一次登記加兌換。
 *
 * 本檔負責線上 payload、交換憑證 map 的序列化邊界，以及開票人端依序登記、
 * 兌換與授予寄存額度。CourierService 只負責傳輸與 request/reply 關聯。
 */
import { CourierIOUBook } from '../incentive/CourierIOU';
import {
  IssuerEndorsementRegistry,
  type SwapRegistrationBundle,
} from '../incentive/IssuerEndorsementRegistry';
import {
  IssuerRedemptionBook,
  type ServiceRedeemRequest,
} from '../incentive/ServiceIOURedemption';
import type {
  ServiceEndorsement,
  ServiceIOU,
  ServiceIOURejectReason,
} from '../incentive/ServiceIOU';

export interface CourierServiceRedeemPayload {
  iou: ServiceIOU;
  chain: ServiceEndorsement[];
  request: ServiceRedeemRequest;
  /** Map 無法直接經 JSON 傳輸，線上格式用 [seq, bundle] 陣列。 */
  swapBundles?: Array<[number, SwapRegistrationBundle]>;
}

export type CourierServiceRedeemAck =
  | {
    accepted: true;
    remaining: number;
    serviceEffect: 'custody-quota';
    granted: number;
  }
  | {
    accepted: true;
    remaining: number;
    serviceEffect: 'none';
  }
  | {
    accepted: false;
    reason: ServiceIOURejectReason;
    /** false 表示此 server 未接上完整服務欠條簿，不是協議內容遭拒。 */
    serviceAvailable?: false;
  };

export interface ServiceIOUCourierBooks {
  iouBook?: CourierIOUBook;
  endorsementRegistry?: IssuerEndorsementRegistry;
  redemptionBook?: IssuerRedemptionBook;
}

function parseSwapBundles(
  value: unknown
): ReadonlyMap<number, SwapRegistrationBundle> | null {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) return null;
  const bundles = new Map<number, SwapRegistrationBundle>();
  for (const entry of value) {
    if (!Array.isArray(entry)
      || entry.length !== 2
      || !Number.isSafeInteger(entry[0])
      || entry[0] < 1
      || !entry[1]
      || typeof entry[1] !== 'object'
      || bundles.has(entry[0])) return null;
    bundles.set(entry[0], entry[1] as SwapRegistrationBundle);
  }
  return bundles;
}

export function serviceRedeemPayload(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  request: ServiceRedeemRequest,
  swapBundles?: ReadonlyMap<number, SwapRegistrationBundle>
): CourierServiceRedeemPayload {
  return {
    iou,
    chain: [...chain],
    request,
    swapBundles: swapBundles ? [...swapBundles.entries()] : undefined,
  };
}

export async function redeemServiceIOU(
  value: unknown,
  books: ServiceIOUCourierBooks,
  now: number
): Promise<CourierServiceRedeemAck> {
  if (!books.endorsementRegistry || !books.redemptionBook || !books.iouBook) {
    return {
      accepted: false,
      reason: 'unknown-iou',
      serviceAvailable: false,
    };
  }
  if (!value || typeof value !== 'object') {
    return { accepted: false, reason: 'malformed' };
  }
  const payload = value as Partial<CourierServiceRedeemPayload>;
  const swapBundles = parseSwapBundles(payload.swapBundles);
  if (!payload.iou || !Array.isArray(payload.chain) || !payload.request || !swapBundles) {
    return { accepted: false, reason: 'malformed' };
  }

  const registration = await books.endorsementRegistry.register(
    payload.iou,
    payload.chain,
    { now, swapBundles }
  );
  if (registration.status === 'rejected') {
    return { accepted: false, reason: registration.reason };
  }

  const redemption = await books.redemptionBook.redeem(
    payload.iou,
    payload.chain,
    payload.request,
    { now }
  );
  if (!redemption.accepted) return redemption;
  if (payload.iou.denomination.unit !== 'custody-byte-days') {
    return {
      accepted: true,
      remaining: redemption.remaining,
      serviceEffect: 'none',
    };
  }
  return {
    accepted: true,
    remaining: redemption.remaining,
    serviceEffect: 'custody-quota',
    granted: books.iouBook.grantCustodyQuota(
      payload.request.claimant.nodeId,
      redemption.granted
    ),
  };
}
