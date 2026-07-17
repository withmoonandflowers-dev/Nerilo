/**
 * DirectoryPeerKeyResolver — 從房間名冊解析對端金鑰（Spec 005 T3）。
 *
 * warm signaling 信封要（1）對收端 ECDH 公鑰加密、（2）驗發起方 ECDSA 簽章。
 * 兩把公鑰都已在名冊裡（meshIdentities[uid].ecdhPubKey / .pubKey，Base64 SPKI，
 * keyx 與 gossip 驗簽既有發布管道）——本模組把「查名冊 → import 成 CryptoKey /
 * VerifyFn」封成 PeerKeyResolver，含以金鑰材料為鍵的快取（輪替換料自動失效）。
 *
 * 名冊來源以函式注入（生產＝directory snapshot；測試＝記憶體 map），零 I/O、零 firebase。
 */
import type { PeerKeyResolver } from './PeerRelaySignalingTransport';
import type { VerifyFn } from './SignalEnvelope';
import { base64ToArrayBuffer } from '../../utils/crypto';

/** 名冊上一位成員的金鑰材料（皆 Base64 SPKI）。 */
export interface PeerKeyMaterial {
  /** ECDSA 身分公鑰（驗簽）。 */
  pubKey?: string;
  /** ECDH 公鑰（封加密信封）。 */
  ecdhPubKey?: string;
}

export function createDirectoryPeerKeyResolver(
  getMaterial: (uid: string) => Promise<PeerKeyMaterial | undefined> | PeerKeyMaterial | undefined
): PeerKeyResolver {
  // 快取鍵含金鑰材料本身：對方輪替金鑰（重新註冊身分）→ 材料變 → 自動重 import。
  const ecdhCache = new Map<string, CryptoKey>();
  const verifyCache = new Map<string, VerifyFn>();

  return {
    async ecdhPublicOf(uid: string): Promise<CryptoKey> {
      const material = await getMaterial(uid);
      if (!material?.ecdhPubKey) {
        throw new Error(`DirectoryPeerKeyResolver: ${uid} 未發布 ecdhPubKey`);
      }
      const cacheKey = `${uid}:${material.ecdhPubKey}`;
      let key = ecdhCache.get(cacheKey);
      if (!key) {
        key = await crypto.subtle.importKey(
          'spki',
          base64ToArrayBuffer(material.ecdhPubKey),
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          [] // 公鑰無 usages（同 RoomKeyCoordinator.importEcdhPublic）
        );
        ecdhCache.set(cacheKey, key);
      }
      return key;
    },

    async verifierOf(uid: string): Promise<VerifyFn> {
      const material = await getMaterial(uid);
      if (!material?.pubKey) {
        throw new Error(`DirectoryPeerKeyResolver: ${uid} 未發布 pubKey`);
      }
      const cacheKey = `${uid}:${material.pubKey}`;
      let fn = verifyCache.get(cacheKey);
      if (!fn) {
        const pub = await crypto.subtle.importKey(
          'spki',
          base64ToArrayBuffer(material.pubKey),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify']
        );
        const enc = new TextEncoder();
        fn = async (data: string, sig: string) =>
          crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            pub,
            base64ToArrayBuffer(sig),
            enc.encode(data)
          );
        verifyCache.set(cacheKey, fn);
      }
      return fn;
    },
  };
}
