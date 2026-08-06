import type { ChatMessage } from '../src/types';

export interface McpMessage {
  messageId: string;
  from: string;
  text: string;
  timestamp: number;
  replyTo?: string;
}

export interface MessagePage {
  messages: McpMessage[];
  nextCursor?: string;
}

export interface RoomStatus {
  roomId: string;
  me: string;
  messageCount: number;
  members: string[];
}

export interface RuntimeCapabilities {
  runtime: string;
  networked: boolean;
  persistent: boolean;
  e2ee: boolean;
  crossProcess: boolean;
  notes: readonly string[];
}

/** MCP 意圖層與實際 Nerilo 執行環境的邊界。browser bridge 可直接實作此介面。 */
export interface NeriloMcpRuntime {
  readonly agentId: string;
  readonly capabilities: RuntimeCapabilities;
  createRoom(name?: string): Promise<{ roomId: string; joined: true }>;
  joinRoom(roomId: string): Promise<{ roomId: string; joined: true }>;
  sendMessage(roomId: string, text: string, replyToId?: string): Promise<{ messageId: string }>;
  getMessages(roomId: string, options: { limit: number; cursor?: string }): Promise<MessagePage>;
  roomStatus(roomId: string): Promise<RoomStatus>;
  listRooms(): Promise<Array<{ roomId: string; me: string; inboxCount: number }>>;
  dispose(): Promise<void>;
}

export function decodeMessage(
  message: ChatMessage,
  decode: (message: ChatMessage) => { text: string; replyTo?: string }
): McpMessage {
  const content = decode(message);
  return {
    messageId: message.messageId,
    from: message.from,
    text: content.text,
    timestamp: message.timestamp,
    ...(content.replyTo ? { replyTo: content.replyTo } : {}),
  };
}
