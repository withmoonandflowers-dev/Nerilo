/**
 * 備援密文的有界等待解密（Spec 012 實作期修訂三）。
 *
 * 重進房間初期，Firestore 訂閱的初始 snapshot 常早於 mesh 服務初始化與金鑰重生
 * （複本 keyx 重放／keyx 傳播）就緒。解密器以輪詢等待服務與金鑰，逾時才拋錯——
 * 搭配 `skipUndecryptable`（mesh 房解不開＝跳過），避免佔位訊息以同 messageId
 * 先入列、把稍後可解密的 gossip 權威副本永久擋在 id 去重之外。
 */
import type { FallbackEncryptedContent } from '../../services/FirestoreChatFallback';

interface FallbackDecryptor {
  decryptFromFallback(payload: FallbackEncryptedContent, senderId: string): Promise<string>;
}

export function boundedFallbackDecrypt(
  resolve: () => FallbackDecryptor | null | undefined,
  opts: { timeoutMs?: number; pollMs?: number; notReadyMessage?: string } = {}
): (payload: FallbackEncryptedContent, senderId: string) => Promise<string> {
  const { timeoutMs = 20_000, pollMs = 300, notReadyMessage = 'fallback decryptor not ready' } = opts;
  return async (payload, senderId) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const svc = resolve();
      if (svc) {
        try {
          return await svc.decryptFromFallback(payload, senderId);
        } catch (e) {
          if (Date.now() >= deadline) throw e; // 逾時仍解不開（如缺該 epoch 金鑰）
        }
      } else if (Date.now() >= deadline) {
        throw new Error(notReadyMessage); // 服務逾時未就緒
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
}
