import type { P2PEnvelope } from '../../types';

export interface ProtocolSchema {
  namespace: string;
  types: string[];
  payloadSchema?: Record<string, any>;
  validator?: (payload: any) => boolean;
}

export type ProtocolHandler = (envelope: P2PEnvelope) => void | Promise<void>;

export class P2PProtocolRegistry {
  private protocols: Map<string, ProtocolSchema> = new Map();
  private handlers: Map<string, ProtocolHandler> = new Map();

  // 官方保留的 namespace
  private readonly reservedNamespaces = ['system', 'chat', 'file', 'media', 'sync'];

  register(schema: ProtocolSchema, handler?: ProtocolHandler): void {
    // 驗證 namespace 格式
    if (this.reservedNamespaces.includes(schema.namespace)) {
      throw new Error(`Namespace "${schema.namespace}" is reserved`);
    }

    if (!schema.namespace.startsWith('feature.')) {
      throw new Error(`Custom namespace must start with "feature."`);
    }

    // 驗證 types
    if (!schema.types || schema.types.length === 0) {
      throw new Error('Protocol must define at least one type');
    }

    this.protocols.set(schema.namespace, schema);

    if (handler) {
      this.handlers.set(schema.namespace, handler);
    }
  }

  validate(envelope: P2PEnvelope): { valid: boolean; error?: string } {
    // 基本欄位驗證
    if (!envelope.v || !envelope.ns || !envelope.type || !envelope.id || !envelope.ts || !envelope.from) {
      return { valid: false, error: 'Missing required envelope fields' };
    }

    // 檢查 namespace 是否註冊（非保留 namespace）
    if (!this.reservedNamespaces.includes(envelope.ns)) {
      if (!envelope.ns.startsWith('feature.')) {
        return { valid: false, error: `Unknown namespace: ${envelope.ns}` };
      }

      const protocol = this.protocols.get(envelope.ns);
      if (!protocol) {
        return { valid: false, error: `Unregistered namespace: ${envelope.ns}` };
      }

      // 檢查 type 是否在允許的 types 中
      if (!protocol.types.includes(envelope.type)) {
        return { valid: false, error: `Invalid type "${envelope.type}" for namespace "${envelope.ns}"` };
      }

      // 執行自訂驗證器
      if (protocol.validator && !protocol.validator(envelope.payload)) {
        return { valid: false, error: `Payload validation failed for ${envelope.ns}:${envelope.type}` };
      }
    }

    return { valid: true };
  }

  getHandler(namespace: string): ProtocolHandler | undefined {
    return this.handlers.get(namespace);
  }

  getProtocol(namespace: string): ProtocolSchema | undefined {
    return this.protocols.get(namespace);
  }

  isRegistered(namespace: string): boolean {
    return this.protocols.has(namespace) || this.reservedNamespaces.includes(namespace);
  }

  listProtocols(): ProtocolSchema[] {
    return Array.from(this.protocols.values());
  }

  unregister(namespace: string): void {
    if (this.reservedNamespaces.includes(namespace)) {
      throw new Error(`Cannot unregister reserved namespace: ${namespace}`);
    }
    this.protocols.delete(namespace);
    this.handlers.delete(namespace);
  }
}



