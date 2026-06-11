/**
 * ChannelRegistry
 *
 * Manages channels within a community. Each channel maps to
 * a backing room (roomId) that can be used with MeshGossipManager.
 *
 * Supports text, announcement (write-restricted), and voice channels.
 */

import { generateUUID } from '../../utils/uuid';
import type {
  ChannelInfo,
  ChannelType,
  CommunityEvent,
  CommunityRole,
} from './types';
import { RolePermissionManager } from './RolePermissionManager';

export class ChannelRegistry {
  private channels = new Map<string, ChannelInfo>();
  private eventListeners = new Set<(event: CommunityEvent) => void>();

  constructor(
    private communityId: string,
    private permissions: RolePermissionManager
  ) {}

  /**
   * Create a new channel.
   */
  createChannel(
    actorId: string,
    actorRole: CommunityRole,
    name: string,
    type: ChannelType = 'text',
    description = ''
  ): ChannelInfo {
    this.permissions.assert(actorRole, 'channel:create');

    // Validate unique name
    for (const ch of this.channels.values()) {
      if (ch.name === name && !ch.archived) {
        throw new Error(`Channel "${name}" already exists`);
      }
    }

    const channel: ChannelInfo = {
      channelId: generateUUID(),
      name,
      description,
      type,
      roomId: generateUUID(), // Each channel gets its own mesh room
      createdBy: actorId,
      createdAt: Date.now(),
      archived: false,
    };

    this.channels.set(channel.channelId, channel);

    this.emit('channel:created', actorId, channel.channelId, {
      name,
      type,
      roomId: channel.roomId,
    });

    return channel;
  }

  /**
   * Delete a channel.
   */
  deleteChannel(
    actorId: string,
    actorRole: CommunityRole,
    channelId: string
  ): void {
    this.permissions.assert(actorRole, 'channel:delete');
    const channel = this.getChannelOrThrow(channelId);

    this.channels.delete(channelId);
    this.emit('channel:deleted', actorId, channelId, { name: channel.name });
  }

  /**
   * Archive a channel (soft-delete, read-only).
   */
  archiveChannel(
    actorId: string,
    actorRole: CommunityRole,
    channelId: string
  ): void {
    this.permissions.assert(actorRole, 'channel:delete');
    const channel = this.getChannelOrThrow(channelId);

    channel.archived = true;
    this.emit('channel:archived', actorId, channelId, { name: channel.name });
  }

  /**
   * Rename a channel.
   */
  renameChannel(
    actorId: string,
    actorRole: CommunityRole,
    channelId: string,
    newName: string
  ): void {
    this.permissions.assert(actorRole, 'channel:rename');
    const channel = this.getChannelOrThrow(channelId);

    // Check name uniqueness among active channels
    for (const ch of this.channels.values()) {
      if (ch.channelId !== channelId && ch.name === newName && !ch.archived) {
        throw new Error(`Channel "${newName}" already exists`);
      }
    }

    const oldName = channel.name;
    channel.name = newName;
    this.emit('channel:created', actorId, channelId, { oldName, newName });
  }

  /**
   * Check if a role can send messages in a channel.
   * Announcement channels restrict writing to moderator+.
   */
  canSendMessage(role: CommunityRole, channelId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || channel.archived) return false;

    if (channel.type === 'announcement') {
      return this.permissions.can(role, 'announcement:create');
    }

    return this.permissions.can(role, 'message:send');
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getChannel(channelId: string): ChannelInfo | undefined {
    return this.channels.get(channelId);
  }

  getChannelOrThrow(channelId: string): ChannelInfo {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Channel "${channelId}" not found`);
    }
    return channel;
  }

  getChannelByName(name: string): ChannelInfo | undefined {
    for (const ch of this.channels.values()) {
      if (ch.name === name && !ch.archived) return ch;
    }
    return undefined;
  }

  getAllChannels(): ChannelInfo[] {
    return Array.from(this.channels.values()).filter(c => !c.archived);
  }

  getArchivedChannels(): ChannelInfo[] {
    return Array.from(this.channels.values()).filter(c => c.archived);
  }

  getChannelCount(): number {
    return this.getAllChannels().length;
  }

  getChannelsByType(type: ChannelType): ChannelInfo[] {
    return this.getAllChannels().filter(c => c.type === type);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  onEvent(listener: (event: CommunityEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(
    type: CommunityEvent['type'],
    actorId: string,
    targetId?: string,
    data?: Record<string, unknown>
  ): void {
    const event: CommunityEvent = {
      type,
      communityId: this.communityId,
      actorId,
      targetId,
      data,
      timestamp: Date.now(),
    };
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}
