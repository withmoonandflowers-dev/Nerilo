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
        const payload = env.payload as ChatSendPayload;
        await _ctx.appendLedger('chat:message', payload);
        break;
      }

      case 'chat:MSG_EDIT': {
        const payload = env.payload as ChatEditPayload;
        await _ctx.appendLedger('chat:edit', payload);
        break;
      }

      case 'chat:MSG_DELETE': {
        const payload = env.payload as ChatDeletePayload;
        await _ctx.appendLedger('chat:delete', payload);
        break;
      }

      case 'chat:TYPING': {
        // Typing indicators are not persisted to the ledger
        const payload = env.payload as ChatTypingPayload;
        _ctx.logger.info('[ChatFeature] typing indicator', { from: env.from, isTyping: payload.isTyping });
        for (const cb of typingCallbacks) {
          cb(payload);
        }
        break;
      }

      case 'chat:REACT': {
        const payload = env.payload as ChatReactPayload;
        await _ctx.appendLedger('chat:react', payload);
        break;
      }

      default:
        // Unknown type - ignore gracefully
        break;
    }
  },
};
