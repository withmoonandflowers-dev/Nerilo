import type { FeatureModule, Envelope, FeatureContext } from '../../types';

export class FeatureRegistry {
  private modules = new Map<string, FeatureModule>();
  private ctx: FeatureContext | null = null;

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
    this.ctx = ctx;
    for (const module of this.modules.values()) {
      await module.setup(ctx);
    }
  }

  async teardownAll(): Promise<void> {
    for (const module of this.modules.values()) {
      await module.teardown();
    }
    this.ctx = null;
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
}
