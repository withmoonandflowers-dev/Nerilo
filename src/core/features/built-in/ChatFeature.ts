import type { FeatureModule, FeatureContext, Envelope } from '../../../types';

export interface ChatSendPayload {
  messageId: string;
  text: string;
  replyTo?: string;
  mentions?: string[];
}

export interface ChatEditPayload {
  messageId: string;
  newText: string;
  editedAt: number;
}

export interface ChatDeletePayload {
  messageId: string;
  deletedAt: number;
}

export interface ChatReactPayload {
  messageId: string;
  emoji: string;
  userId: string;
}

export interface ChatTypingPayload {
  userId: string;
  isTyping: boolean;
}

// ── Runtime payload validators ──────────────────────────────────────────────

function isValidChatSend(p: unknown): p is ChatSendPayload {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return typeof obj.messageId === 'string' && typeof obj.text === 'string';
}

function isValidChatEdit(p: unknown): p is ChatEditPayload {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return typeof obj.messageId === 'string' && typeof obj.newText === 'string' && typeof obj.editedAt === 'number';
}

function isValidChatDelete(p: unknown): p is ChatDeletePayload {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return typeof obj.messageId === 'string' && typeof obj.deletedAt === 'number';
}

function isValidChatReact(p: unknown): p is ChatReactPayload {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return typeof obj.messageId === 'string' && typeof obj.emoji === 'string' && typeof obj.userId === 'string';
}

function isValidChatTyping(p: unknown): p is ChatTypingPayload {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return typeof obj.userId === 'string' && typeof obj.isTyping === 'boolean';
}

let _ctx: FeatureContext | null = null;
const typingCallbacks: Array<(payload: ChatTypingPayload) => void> = [];

export const ChatFeature: FeatureModule = {
  name: 'chat',
  version: '1.0.0',
  namespaces: ['chat'],
  capabilities: ['chat:send', 'chat:edit', 'chat:delete', 'chat:react', 'chat:typing'],

  async setup(ctx: FeatureContext): Promise<void> {
    _ctx = ctx;
    ctx.logger.info('[ChatFeature] setup complete', { selfId: ctx.selfId, roomId: ctx.roomId });
  },

  async teardown(): Promise<void> {
    _ctx = null;
    typingCallbacks.length = 0;
    // No additional cleanup needed
  },

  async onPeerJoin(peerId: string): Promise<void> {
    _ctx?.logger.info('[ChatFeature] peer joined', { peerId });
  },

  async onPeerLeave(peerId: string): Promise<void> {
    _ctx?.logger.info('[ChatFeature] peer left', { peerId });
  },

  async handleEnvelope(env: Envelope): Promise<void> {
    if (!_ctx) return;

    switch (env.type) {
      case 'chat:MSG_SEND': {
        if (!isValidChatSend(env.payload)) {
          _ctx.logger.warn('[ChatFeature] Invalid MSG_SEND payload, dropping', { from: env.from });
          return;
        }
        await _ctx.appendLedger('chat:message', env.payload);
        break;
      }

      case 'chat:MSG_EDIT': {
        if (!isValidChatEdit(env.payload)) {
          _ctx.logger.warn('[ChatFeature] Invalid MSG_EDIT payload, dropping', { from: env.from });
          return;
        }
        await _ctx.appendLedger('chat:edit', env.payload);
        break;
      }

      case 'chat:MSG_DELETE': {
        if (!isValidChatDelete(env.payload)) {
          _ctx.logger.warn('[ChatFeature] Invalid MSG_DELETE payload, dropping', { from: env.from });
          return;
        }
        await _ctx.appendLedger('chat:delete', env.payload);
        break;
      }

      case 'chat:TYPING': {
        if (!isValidChatTyping(env.payload)) {
          _ctx.logger.warn('[ChatFeature] Invalid TYPING payload, dropping', { from: env.from });
          return;
        }
        _ctx.logger.info('[ChatFeature] typing indicator', { from: env.from, isTyping: env.payload.isTyping });
        for (const cb of typingCallbacks) {
          cb(env.payload);
        }
        break;
      }

      case 'chat:REACT': {
        if (!isValidChatReact(env.payload)) {
          _ctx.logger.warn('[ChatFeature] Invalid REACT payload, dropping', { from: env.from });
          return;
        }
        await _ctx.appendLedger('chat:react', env.payload);
        break;
      }

      default:
        // Unknown type - ignore gracefully
        break;
    }
  },
};
