/**
 * CommunityManager — Orchestrator
 *
 * High-level API that coordinates MembershipService, ChannelRegistry,
 * and RolePermissionManager into a unified community management layer.
 *
 * Usage:
 *   const mgr = CommunityManager.create('My Community', ownerId, ownerName);
 *   mgr.createChannel(ownerId, 'general');
 *   mgr.inviteMember(ownerId, 'user2', 'Alice');
 */

import { generateUUID } from '../../utils/uuid';
import type {
  CommunityInfo,
  CommunityMember,
  CommunityRole,
  ChannelInfo,
  ChannelType,
  CommunityEvent,
  PermissionPolicy,
} from './types';
import { RolePermissionManager } from './RolePermissionManager';
import { MembershipService } from './MembershipService';
import { ChannelRegistry } from './ChannelRegistry';

export class CommunityManager {
  readonly communityInfo: CommunityInfo;
  readonly permissions: RolePermissionManager;
  readonly membership: MembershipService;
  readonly channels: ChannelRegistry;
  private eventListeners = new Set<(event: CommunityEvent) => void>();

  private constructor(
    communityInfo: CommunityInfo,
    permissions: RolePermissionManager,
    membership: MembershipService,
    channels: ChannelRegistry
  ) {
    this.communityInfo = communityInfo;
    this.permissions = permissions;
    this.membership = membership;
    this.channels = channels;

    // Forward sub-component events
    this.membership.onEvent((e) => this.forwardEvent(e));
    this.channels.onEvent((e) => this.forwardEvent(e));
  }

  /**
   * Create a new community with a founder and default "general" channel.
   */
  static create(
    name: string,
    ownerId: string,
    ownerDisplayName: string,
    options: {
      description?: string;
      joinPolicy?: 'open' | 'invite-only';
      requiredVouches?: number;
      permissionOverrides?: Partial<PermissionPolicy>;
    } = {}
  ): CommunityManager {
    const communityId = generateUUID();
    const info: CommunityInfo = {
      communityId,
      name,
      description: options.description ?? '',
      ownerId,
      createdAt: Date.now(),
      joinPolicy: options.joinPolicy ?? 'open',
      requiredVouches: options.requiredVouches ?? 1,
      permissionOverrides: options.permissionOverrides ?? {},
    };

    const permissions = new RolePermissionManager(info.permissionOverrides);
    const membership = new MembershipService(info, permissions);
    const channels = new ChannelRegistry(communityId, permissions);

    // Add founder
    membership.addFounder(ownerId, ownerDisplayName);

    // Create default "general" channel
    channels.createChannel(ownerId, 'owner', 'general', 'text', 'General discussion');

    return new CommunityManager(info, permissions, membership, channels);
  }

  // ── Convenience API (delegates to sub-services) ────────────────────────

  /**
   * Create a channel (permission-checked).
   */
  createChannel(
    actorId: string,
    name: string,
    type: ChannelType = 'text',
    description = ''
  ): ChannelInfo {
    const actor = this.membership.getMemberOrThrow(actorId);
    return this.channels.createChannel(actorId, actor.role, name, type, description);
  }

  /**
   * Delete a channel (permission-checked).
   */
  deleteChannel(actorId: string, channelId: string): void {
    const actor = this.membership.getMemberOrThrow(actorId);
    this.channels.deleteChannel(actorId, actor.role, channelId);
  }

  /**
   * Archive a channel (permission-checked).
   */
  archiveChannel(actorId: string, channelId: string): void {
    const actor = this.membership.getMemberOrThrow(actorId);
    this.channels.archiveChannel(actorId, actor.role, channelId);
  }

  /**
   * Rename a channel (permission-checked).
   */
  renameChannel(actorId: string, channelId: string, newName: string): void {
    const actor = this.membership.getMemberOrThrow(actorId);
    this.channels.renameChannel(actorId, actor.role, channelId, newName);
  }

  /**
   * Invite a member (with vouch tracking for invite-only communities).
   */
  inviteMember(
    inviterId: string,
    inviteeId: string,
    inviteeDisplayName: string
  ): ReturnType<MembershipService['invite']> {
    return this.membership.invite(inviterId, inviteeId, inviteeDisplayName);
  }

  /**
   * Join an open community.
   */
  joinCommunity(userId: string, displayName: string): CommunityMember {
    return this.membership.join(userId, displayName);
  }

  /**
   * Leave the community.
   */
  leaveCommunity(userId: string): void {
    this.membership.leave(userId);
  }

  /**
   * Kick a member (permission-checked, hierarchy-enforced).
   */
  kickMember(actorId: string, targetId: string): void {
    this.membership.kick(actorId, targetId);
  }

  /**
   * Ban a member (permission-checked, hierarchy-enforced).
   */
  banMember(actorId: string, targetId: string): void {
    this.membership.ban(actorId, targetId);
  }

  /**
   * Change a member's role (permission-checked, hierarchy-enforced).
   */
  changeRole(actorId: string, targetId: string, newRole: CommunityRole): void {
    this.membership.changeRole(actorId, targetId, newRole);
  }

  /**
   * Transfer ownership.
   */
  transferOwnership(currentOwnerId: string, newOwnerId: string): void {
    this.membership.transferOwnership(currentOwnerId, newOwnerId);
  }

  /**
   * Check if a user can send a message in a specific channel.
   */
  canSendMessage(userId: string, channelId: string): boolean {
    const member = this.membership.getMember(userId);
    if (!member) return false;
    return this.channels.canSendMessage(member.role, channelId);
  }

  // ── State queries ──────────────────────────────────────────────────────

  getMemberCount(): number {
    return this.membership.getMemberCount();
  }

  getChannelCount(): number {
    return this.channels.getChannelCount();
  }

  getSummary(): {
    communityId: string;
    name: string;
    memberCount: number;
    channelCount: number;
    joinPolicy: string;
  } {
    return {
      communityId: this.communityInfo.communityId,
      name: this.communityInfo.name,
      memberCount: this.getMemberCount(),
      channelCount: this.getChannelCount(),
      joinPolicy: this.communityInfo.joinPolicy,
    };
  }

  // ── Events ─────────────────────────────────────────────────────────────

  onEvent(listener: (event: CommunityEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private forwardEvent(event: CommunityEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}
