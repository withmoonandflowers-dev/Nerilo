/**
 * 延遲載入的 SignalingTransport 包裝（Spec 015 T2）。
 *
 * 為什麼需要它：`SignalingFactory` 契約要求**同步**回傳一個 transport，但把 Firestore
 * adapter 開成 SDK 出口時必須用動態 `import()`（否則 `nerilo` 的 eager 進入點會靜態
 * 帶進 firebase，`qa:sdk-isolation` 直接紅）。兩個要求對撞，這層就是接縫。
 *
 * 最容易寫錯的一點：`subscribe()` 必須**當下**回傳取消函式，而此時真正的 transport
 * 還沒載完。所以取消函式要能取消一個「尚未成立的訂閱」——載完後若已被取消，就不能
 * 再真的去訂閱，否則會留下永遠拆不掉的監聽（Firestore onSnapshot 會一直計費、
 * 也會在房間關閉後繼續投遞）。
 */
import type { RawSignalDoc, SignalingTransport } from './SignalingTransport.types';

export function createLazySignalingTransport(
  load: () => Promise<SignalingTransport>
): SignalingTransport {
  let inner: Promise<SignalingTransport> | null = null;
  const ensure = () => (inner ??= load());

  return {
    subscribe(cutoffMs: number, onAdded: (raw: RawSignalDoc) => void): () => void {
      let cancelled = false;
      let innerUnsub: (() => void) | null = null;

      void ensure()
        .then((t) => {
          if (cancelled) return; // 載完前就被取消 → 根本不要訂閱
          innerUnsub = t.subscribe(cutoffMs, onAdded);
        })
        .catch(() => {
          // 載入失敗不炸呼叫端：signaling 建不起來的後果由上層的連線逾時處理，
          // 這裡多丟一個 unhandled rejection 只會蓋掉真正的錯誤訊號。
        });

      return () => {
        cancelled = true;
        innerUnsub?.();
        innerUnsub = null;
      };
    },

    async send(data: Record<string, unknown>): Promise<void> {
      return (await ensure()).send(data);
    },

    async cleanupOlderThan(beforeMs: number): Promise<void> {
      return (await ensure()).cleanupOlderThan(beforeMs);
    },

    async cleanupOwn(localUid: string): Promise<void> {
      return (await ensure()).cleanupOwn(localUid);
    },
  };
}
