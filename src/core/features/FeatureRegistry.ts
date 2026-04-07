import type { FeatureModule, Envelope, FeatureContext } from '../../types';
import type { IndexedDBService } from '../../services/IndexedDBService';

export class FeatureRegistry {
  private modules = new Map<string, FeatureModule>();

  register(module: FeatureModule): void {
    if (this.modules.has(module.name)) {
      throw new Error(`[FeatureRegistry] Module '${module.name}' is already registered`);
    }
    this.modules.set(module.name, module);
  }

  async unregister(name: string): Promise<void> {
    const module = this.modules.get(name);
    if (module) {
      await module.teardown();
      this.modules.delete(name);
    }
  }

  get(name: string): FeatureModule | undefined {
    return this.modules.get(name);
  }

  list(): FeatureModule[] {
    return Array.from(this.modules.values());
  }

  has(name: string): boolean {
    return this.modules.has(name);
  }

  async setupAll(ctx: FeatureContext): Promise<void> {
    for (const module of this.modules.values()) {
      await module.setup(ctx);
    }
  }

  async teardownAll(): Promise<void> {
    for (const module of this.modules.values()) {
      await module.teardown();
    }
  }

  async dispatch(env: Envelope): Promise<void> {
    for (const module of this.modules.values()) {
      if (module.namespaces.includes(env.ns) && module.handleEnvelope) {
        await module.handleEnvelope(env);
      }
    }
  }

  async notifyPeerJoin(peerId: string): Promise<void> {
    for (const module of this.modules.values()) {
      if (module.onPeerJoin) {
        await module.onPeerJoin(peerId);
      }
    }
  }

  async notifyPeerLeave(peerId: string): Promise<void> {
    for (const module of this.modules.values()) {
      if (module.onPeerLeave) {
        await module.onPeerLeave(peerId);
      }
    }
  }

  getSupportedCapabilities(): string[] {
    const caps = new Set<string>();
    for (const module of this.modules.values()) {
      for (const cap of module.capabilities) {
        caps.add(cap);
      }
    }
    return Array.from(caps);
  }

  getSupportedNamespaces(): string[] {
    const ns = new Set<string>();
    for (const module of this.modules.values()) {
      for (const n of module.namespaces) {
        ns.add(n);
      }
    }
    return Array.from(ns);
  }

  // ── Store Factory ─────────────────────────────────────────────────────────

  /**
   * 建立一個與 IndexedDB 綁定的 FeatureContext.store。
   *
   * 使用方式：
   * ```ts
   * const ctx: FeatureContext = {
   *   selfId,
   *   roomId,
   *   send,
   *   broadcast,
   *   appendLedger,
   *   store: FeatureRegistry.createStore(roomId, indexedDBService),
   *   logger,
   * };
   * await registry.setupAll(ctx);
   * ```
   *
   * key 命名慣例：建議加上 feature 前綴，例如 `chat:draft` 避免衝突。
   *
   * @param roomId  目前房間 ID（自動作為 namespace 隔離不同房間的資料）
   * @param db      IndexedDBService 實例（通常使用全域 `indexedDBService` singleton）
   */
  static createStore(roomId: string, db: IndexedDBService): FeatureContext['store'] {
    return {
      get: (key: string) => db.getFeatureState(roomId, key),
      set: (key: string, value: unknown) => db.setFeatureState(roomId, key, value),
      delete: (key: string) => db.deleteFeatureState(roomId, key),
    };
  }

  /**
   * 便利方法：setupAll 的擴充版本。
   * 自動從 IndexedDB 注入 store，呼叫端不需要手動建立 store 物件。
   *
   * @param baseCtx  除 store 以外的 FeatureContext 欄位
   * @param db       IndexedDBService 實例
   */
  async setupAllWithStore(
    baseCtx: Omit<FeatureContext, 'store'>,
    db: IndexedDBService
  ): Promise<void> {
    const store = FeatureRegistry.createStore(baseCtx.roomId, db);
    await this.setupAll({ ...baseCtx, store });
  }
}
