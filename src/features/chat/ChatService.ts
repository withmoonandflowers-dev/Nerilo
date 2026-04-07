import type {
  P2PEnvelope,
  ChatMessage,
  EncryptedChatPayload,
  ECDHPubKeyPayload,
  SenderKeyDistPayload,
} from '../../types';
import { P2PChannelBus } from '../../core/p2p/P2PChannelBus';
import { generateUUID } from '../../utils/uuid';
import type { IChatStorage } from '../../ports';
import { indexedDBService } from '../../services/IndexedDBService';
import { HybridLogicalClock } from '../../core/clock/HybridLogicalClock';
import type { SenderKeyManager, EncryptedPayload } from '../../core/crypto/SenderKeyManager';

// ── E2EE 相關型別 ──────────────────────────────────────────────────────────

/** ECDH 公鑰暫存：peerUid → CryptoKey */
type PeerECDHKeyMap = Map<string, CryptoKey>;

/** 解析 "uid/deviceId" 格式，取得 uid 部分 */
function extractUid(fromField: string): string {
  return fromField.split('/')[0];
}

// ── ChatService ────────────────────────────────────────────────────────────

export class ChatService {
  private channelBus: P2PChannelBus;
  private localUid: string;
  private deviceId: string;
  private roomId: string;
  private chatStorage: IChatStorage;
  private messageListeners: Set<(message: ChatMessage) => void> = new Set();
  private typingListeners: Set<(data: { userId: string; isTyping: boolean }) => void> = new Set();
  private hlc: HybridLogicalClock;

  // E2EE（可選）
  private senderKeyManager: SenderKeyManager | null;
  private peerECDHKeys: PeerECDHKeyMap = new Map();
  private e2eeReady = false;
  /** 等待 sender key 分發完成的 resolvers */
  private e2eeReadyResolvers: Array<() => void> = [];
  /** 等待 ECDH 公鑰交換的 peer 列表 */
  private pendingKeyExchangePeers: Set<string> = new Set();

  constructor(
    channelBus: P2PChannelBus,
    localUid: string,
    deviceId: string,
    roomId: string,
    chatStorage: IChatStorage = indexedDBService,
    senderKeyManager: SenderKeyManager | null = null
  ) {
    this.channelBus = channelBus;
    this.localUid = localUid;
    this.deviceId = deviceId;
    this.roomId = roomId;
    this.chatStorage = chatStorage;
    this.hlc = new HybridLogicalClock(localUid.slice(0, 8));
    this.senderKeyManager = senderKeyManager;
    this.setupHandlers();
  }

  // ── E2EE 公開 API ──────────────────────────────────────────────────────

  /** E2EE 是否啟用 */
  get isE2EEEnabled(): boolean {
    return this.senderKeyManager !== null;
  }

  /** E2EE 金鑰交換是否完成，可以安全傳送訊息 */
  get isE2EEReady(): boolean {
    return !this.senderKeyManager || this.e2eeReady;
  }

  /**
   * 啟動 E2EE 金鑰交換流程：
   * 1. 廣播自己的 ECDH 公鑰
   * 2. 等待對方回覆 ECDH 公鑰
   * 3. 生成並分發 sender key
   */
  async initiateKeyExchange(): Promise<void> {
    if (!this.senderKeyManager) return;

    const ecdhPub = this.senderKeyManager.getECDHPublicKey();
    if (!ecdhPub) {
      throw new Error('ECDH key pair not initialized — call senderKeyManager.initKeyPair() first');
    }

    // 匯出 ECDH 公鑰為 Base64
    const exported = await crypto.subtle.exportKey('spki', ecdhPub);
    const base64Pub = bufferToBase64(exported);

    // 廣播 ECDH 公鑰
    const payload: ECDHPubKeyPayload = {
      userId: this.localUid,
      ecdhPublicKey: base64Pub,
    };

    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'ECDH_PUBKEY',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload,
    };

    await this.channelBus.send(envelope);
    console.log('[ChatService][E2EE] ECDH public key broadcasted');
  }

  // ── 訊息發送 ──────────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.channelBus.subscribe('chat', async (envelope) => {
      await this.handleChatMessage(envelope);
    });
  }

  async sendMessage(content: string, to?: string): Promise<string> {
    const messageId = generateUUID();
    const hlcTimestamp = this.hlc.now();
    const message: ChatMessage = {
      messageId,
      from: `${this.localUid}/${this.deviceId}`,
      to,
      content,
      timestamp: Date.now(),
      hlc: hlcTimestamp,
    };

    // 本機存入明文
    await this.chatStorage.saveChatMessage(message, this.roomId);

    // 建構 P2P envelope
    let envelopePayload: ChatMessage | EncryptedChatPayload;

    if (this.senderKeyManager && this.e2eeReady) {
      // E2EE 模式：加密 content
      const encrypted = await this.senderKeyManager.encryptMessage(content);
      envelopePayload = {
        messageId,
        from: message.from,
        to,
        timestamp: message.timestamp,
        hlc: hlcTimestamp,
        encrypted: {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          senderKeyEpoch: encrypted.senderKeyEpoch,
        },
      };
    } else {
      // 明文模式（向下相容）
      envelopePayload = message;
    }

    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_SEND',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      to,
      payload: envelopePayload,
    };

    await this.channelBus.send(envelope);

    // 通知本機監聽器
    this.messageListeners.forEach((listener) => listener(message));

    return messageId;
  }

  async editMessage(messageId: string, newContent: string): Promise<void> {
    await this.chatStorage.updateChatMessage(messageId, {
      content: newContent,
      edited: true,
    });

    let payloadContent: string | { ciphertext: string; iv: string; senderKeyEpoch: number };
    if (this.senderKeyManager && this.e2eeReady) {
      const encrypted = await this.senderKeyManager.encryptMessage(newContent);
      payloadContent = {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        senderKeyEpoch: encrypted.senderKeyEpoch,
      };
    } else {
      payloadContent = newContent;
    }

    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_EDIT',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: {
        messageId,
        content: payloadContent,
      },
    };

    await this.channelBus.send(envelope);
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.chatStorage.updateChatMessage(messageId, {
      deleted: true,
    });

    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'MSG_DELETE',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: { messageId },
    };

    await this.channelBus.send(envelope);
  }

  async sendTyping(isTyping: boolean): Promise<void> {
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'TYPING',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: { isTyping },
    };

    await this.channelBus.send(envelope);
  }

  async loadHistory(limit = 100): Promise<ChatMessage[]> {
    return await this.chatStorage.getChatMessages(this.roomId, limit);
  }

  onMessage(listener: (message: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onTyping(listener: (data: { userId: string; isTyping: boolean }) => void): () => void {
    this.typingListeners.add(listener);
    return () => {
      this.typingListeners.delete(listener);
    };
  }

  // ── 訊息接收 ──────────────────────────────────────────────────────────

  private async handleChatMessage(envelope: P2PEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'MSG_SEND':
        await this.handleMessageSend(envelope);
        break;
      case 'MSG_EDIT':
        await this.handleMessageEdit(envelope);
        break;
      case 'MSG_DELETE':
        await this.handleMessageDelete(envelope.payload as { messageId: string });
        break;
      case 'TYPING': {
        const typingPayload = envelope.payload as { isTyping: boolean };
        const typingUserId = extractUid(envelope.from);
        this.typingListeners.forEach((listener) => listener({ userId: typingUserId, isTyping: typingPayload.isTyping }));
        break;
      }
      // E2EE 金鑰交換
      case 'ECDH_PUBKEY':
        await this.handleECDHPubKey(envelope);
        break;
      case 'SENDER_KEY_DIST':
        await this.handleSenderKeyDist(envelope);
        break;
    }
  }

  private async handleMessageSend(envelope: P2PEnvelope): Promise<void> {
    const raw = envelope.payload as Record<string, unknown>;
    let message: ChatMessage;

    if (raw.encrypted && this.senderKeyManager) {
      // 加密訊息：解密 content
      const encPayload = raw as unknown as EncryptedChatPayload;
      const senderId = extractUid(encPayload.from);
      try {
        const plaintext = await this.senderKeyManager.decryptMessage(
          encPayload.encrypted as EncryptedPayload,
          senderId
        );
        message = {
          messageId: encPayload.messageId,
          from: encPayload.from,
          to: encPayload.to,
          content: plaintext,
          timestamp: encPayload.timestamp,
          hlc: encPayload.hlc,
        };
      } catch (err) {
        console.error('[ChatService][E2EE] Failed to decrypt message', {
          from: encPayload.from,
          epoch: encPayload.encrypted?.senderKeyEpoch,
          error: err,
        });
        // 無法解密時以佔位訊息通知使用者
        message = {
          messageId: encPayload.messageId,
          from: encPayload.from,
          to: encPayload.to,
          content: '[無法解密此訊息]',
          timestamp: encPayload.timestamp,
          hlc: encPayload.hlc,
        };
      }
    } else {
      // 明文模式
      message = raw as unknown as ChatMessage;
    }

    // Merge HLC timestamp
    if (message.hlc) {
      this.hlc.receive(message.hlc);
    }

    await this.chatStorage.saveChatMessage(message, this.roomId);
    this.messageListeners.forEach((listener) => listener(message));
  }

  private async handleMessageEdit(envelope: P2PEnvelope): Promise<void> {
    const payload = envelope.payload as {
      messageId: string;
      content: string | { ciphertext: string; iv: string; senderKeyEpoch: number };
    };

    let plainContent: string;
    if (typeof payload.content === 'object' && payload.content.ciphertext && this.senderKeyManager) {
      const senderId = extractUid(envelope.from);
      try {
        plainContent = await this.senderKeyManager.decryptMessage(
          payload.content as EncryptedPayload,
          senderId
        );
      } catch {
        plainContent = '[無法解密此編輯]';
      }
    } else {
      plainContent = payload.content as string;
    }

    await this.chatStorage.updateChatMessage(payload.messageId, {
      content: plainContent,
      edited: true,
    });
  }

  private async handleMessageDelete(payload: { messageId: string }): Promise<void> {
    await this.chatStorage.updateChatMessage(payload.messageId, {
      deleted: true,
    });
  }

  // ── E2EE 金鑰交換處理 ─────────────────────────────────────────────────

  private async handleECDHPubKey(envelope: P2PEnvelope): Promise<void> {
    if (!this.senderKeyManager) return;

    const payload = envelope.payload as ECDHPubKeyPayload;
    const peerUid = payload.userId;

    // 匯入 peer 的 ECDH 公鑰
    const keyData = base64ToBuffer(payload.ecdhPublicKey);
    const peerECDHKey = await crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    this.peerECDHKeys.set(peerUid, peerECDHKey);
    this.pendingKeyExchangePeers.delete(peerUid);

    console.log('[ChatService][E2EE] Received ECDH public key', { peerUid });

    // 回覆自己的 ECDH 公鑰（對方也需要）
    await this.initiateKeyExchange();

    // 生成並分發 sender key 給所有已知 peer
    await this.distributeSenderKeyToAllPeers();
  }

  private async handleSenderKeyDist(envelope: P2PEnvelope): Promise<void> {
    if (!this.senderKeyManager) return;

    const payload = envelope.payload as SenderKeyDistPayload;

    // 匯入 sender 的 ECDH 公鑰
    const keyData = base64ToBuffer(payload.ecdhPublicKey);
    const senderECDHKey = await crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // 接收 sender key
    await this.senderKeyManager.receiveSenderKey(
      {
        senderId: payload.senderId,
        epoch: payload.epoch,
        encryptedKeys: payload.encryptedKeys,
      },
      senderECDHKey
    );

    this.e2eeReady = true;

    console.log('[ChatService][E2EE] Received sender key', {
      from: payload.senderId,
      epoch: payload.epoch,
    });

    // 通知等待者
    this.e2eeReadyResolvers.forEach((resolve) => resolve());
    this.e2eeReadyResolvers = [];
  }

  /**
   * 向所有已收到 ECDH 公鑰的 peer 分發 sender key
   */
  private async distributeSenderKeyToAllPeers(): Promise<void> {
    if (!this.senderKeyManager) return;
    if (this.peerECDHKeys.size === 0) return;

    // 確保有 sender key
    await this.senderKeyManager.generateSenderKey();

    const members = Array.from(this.peerECDHKeys.entries()).map(
      ([peerId, publicKey]) => ({ peerId, publicKey })
    );

    const distribution = await this.senderKeyManager.distributeSenderKey(members);

    // 匯出自己的 ECDH 公鑰
    const myECDHPub = this.senderKeyManager.getECDHPublicKey()!;
    const exported = await crypto.subtle.exportKey('spki', myECDHPub);
    const base64Pub = bufferToBase64(exported);

    const payload: SenderKeyDistPayload = {
      senderId: this.localUid,
      epoch: distribution.epoch,
      ecdhPublicKey: base64Pub,
      encryptedKeys: distribution.encryptedKeys,
    };

    const distEnvelope: P2PEnvelope = {
      v: 1,
      ns: 'chat',
      type: 'SENDER_KEY_DIST',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload,
    };

    await this.channelBus.send(distEnvelope);
    this.e2eeReady = true;

    console.log('[ChatService][E2EE] Sender key distributed', {
      epoch: distribution.epoch,
      recipientCount: members.length,
    });
  }

  /** 等待 E2EE 就緒（用於 UI 層） */
  waitForE2EEReady(timeoutMs = 10_000): Promise<void> {
    if (this.e2eeReady || !this.senderKeyManager) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('E2EE key exchange timed out'));
      }, timeoutMs);

      this.e2eeReadyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
