/**
 * MembershipService
 *
 * Manages community membership: join, leave, invite, kick, ban,
 * and role changes. Enforces permissions via RolePermissionManager.
 *
 * Sybil resistance: invite-only communities require N vouches
 * from existing members before a new member is admitted.
 */

import type {
  CommunityMember,
  CommunityRole,
  CommunityEvent,
  CommunityInfo,
} from './types';
import { ROLE_WEIGHT } from './types';
import { RolePermissionManager } from './RolePermissionManager';

export class MembershipService {
  private members = new Map<string, CommunityMember>();
  /** Pending invitations: inviteeId → Set of voucher userIds */
  private pendingVouches = new Map<string, Set<string>>();
  private eventListeners = new Set<(event: CommunityEvent) => void>();
  private permissions: RolePermissionManager;
  private communityInfo: CommunityInfo;

  constructor(communityInfo: CommunityInfo, permissions: RolePermissionManager) {
    this.communityInfo = communityInfo;
    this.permissions = permissions;
  }

  /**
   * Add the founding owner (no permission check needed).
   */
  addFounder(userId: string, displayName: string): CommunityMember {
    const member: CommunityMember = {
      userId,
      displayName,
      role: 'owner',
      joinedAt: Date.now(),
      invitedBy: null,
      banned: false,
    };
    this.members.set(userId, member);
    return member;
  }

  /**
   * Join an open community directly.
   */
  join(userId: string, displayName: string): CommunityMember {
    if (this.communityInfo.joinPolicy !== 'open') {
      throw new Error('Community is invite-only. Use invite() instead.');
    }
    if (this.members.has(userId)) {
      throw new Error('Already a member');
    }
    if (this.isBanned(userId)) {
      throw new Error('User is banned from this community');
    }

    const member: CommunityMember = {
      userId,
      displayName,
      role: 'member',
      joinedAt: Date.now(),
      invitedBy: null,
      banned: false,
    };
    this.members.set(userId, member);
    this.emit('member:joined', userId, userId);
    return member;
  }

  /**
   * Invite a user to the community.
   * In invite-only mode, requires enough vouches before admission.
   */
  invite(
    inviterId: string,
    inviteeId: string,
    inviteeDisplayName: string
  ): { admitted: boolean; vouchesReceived: number; vouchesRequired: number } {
    const inviter = this.getMemberOrThrow(inviterId);
    this.permissions.assert(inviter.role, 'member:invite');

    if (this.members.has(inviteeId)) {
      throw new Error('User is already a member');
    }
    if (this.isBanned(inviteeId)) {
      throw new Error('User is banned from this community');
    }

    const required = this.communityInfo.requiredVouches;

    // Track vouches
    if (!this.pendingVouches.has(inviteeId)) {
      this.pendingVouches.set(inviteeId, new Set());
    }
    const vouches = this.pendingVouches.get(inviteeId)!;
    vouches.add(inviterId);

    // Check if enough vouches to admit
    if (vouches.size >= required) {
      const member: CommunityMember = {
        userId: inviteeId,
        displayName: inviteeDisplayName,
        role: 'member',
        joinedAt: Date.now(),
        invitedBy: inviterId,
        banned: false,
      };
      this.members.set(inviteeId, member);
      this.pendingVouches.delete(inviteeId);
      this.emit('member:joined', inviterId, inviteeId);
      return { admitted: true, vouchesReceived: vouches.size, vouchesRequired: required };
    }

    return { admitted: false, vouchesReceived: vouches.size, vouchesRequired: required };
  }

  /**
   * Leave a community voluntarily.
   */
  leave(userId: string): void {
    const member = this.getMemberOrThrow(userId);
    if (member.role === 'owner') {
      throw new Error('Owner cannot leave. Transfer ownership first.');
    }
    this.members.delete(userId);
    this.emit('member:left', userId, userId);
  }

  /**
   * Kick a member from the community.
   */
  kick(actorId: string, targetId: string): void {
    const actor = this.getMemberOrThrow(actorId);
    const target = this.getMemberOrThrow(targetId);
    this.permissions.assert(actor.role, 'member:kick');

    if (!this.permissions.outranks(actor.role, target.role)) {
      throw new Error('Cannot kick a member with equal or higher role');
    }

    this.members.delete(targetId);
    this.emit('member:kicked', actorId, targetId);
  }

  /**
   * Ban a member from the community.
   */
  ban(actorId: string, targetId: string): void {
    const actor = this.getMemberOrThrow(actorId);
    this.permissions.assert(actor.role, 'member:ban');

    const target = this.members.get(targetId);
    if (target) {
      if (!this.permissions.outranks(actor.role, target.role)) {
        throw new Error('Cannot ban a member with equal or higher role');
      }
      target.banned = true;
      this.members.delete(targetId);
    }

    // Track ban even for non-members (prevent rejoin)
    this.members.set(`__banned__${targetId}`, {
      userId: targetId,
      displayName: target?.displayName ?? 'unknown',
      role: 'guest',
      joinedAt: 0,
      invitedBy: null,
      banned: true,
    });

    this.emit('member:banned', actorId, targetId);
  }

  /**
   * Change a member's role.
   */
  changeRole(actorId: string, targetId: string, newRole: CommunityRole): void {
    const actor = this.getMemberOrThrow(actorId);
    const target = this.getMemberOrThrow(targetId);
    this.permissions.assert(actor.role, 'member:change-role');

    // Cannot set owner role — use transferOwnership instead
    if (newRole === 'owner') {
      throw new Error('Use transferOwnership() to transfer owner role');
    }

    // Cannot promote to equal or higher than own role
    if (ROLE_WEIGHT[newRole] >= ROLE_WEIGHT[actor.role]) {
      throw new Error('Cannot assign a role equal to or higher than your own');
    }

    // Cannot change role of someone with equal or higher role
    if (!this.permissions.outranks(actor.role, target.role)) {
      throw new Error('Cannot change role of a member with equal or higher role');
    }

    const oldRole = target.role;
    target.role = newRole;
    this.emit('member:role-changed', actorId, targetId, { oldRole, newRole });
  }

  /**
   * Transfer community ownership to another member.
   * Only the current owner can do this.
   */
  transferOwnership(currentOwnerId: string, newOwnerId: string): void {
    const current = this.getMemberOrThrow(currentOwnerId);
    const target = this.getMemberOrThrow(newOwnerId);

    if (current.role !== 'owner') {
      throw new Error('Only the owner can transfer ownership');
    }

    current.role = 'admin';
    target.role = 'owner';
    this.communityInfo.ownerId = newOwnerId;

    this.emit('member:role-changed', currentOwnerId, newOwnerId, {
      oldRole: target.role,
      newRole: 'owner',
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getMember(userId: string): CommunityMember | undefined {
    return this.members.get(userId);
  }

  getMemberOrThrow(userId: string): CommunityMember {
    const member = this.members.get(userId);
    if (!member) {
      throw new Error(`User "${userId}" is not a member of this community`);
    }
    return member;
  }

  getAllMembers(): CommunityMember[] {
    return Array.from(this.members.values()).filter(m => !m.userId.startsWith('__banned__'));
  }

  getMemberCount(): number {
    return this.getAllMembers().length;
  }

  getMembersByRole(role: CommunityRole): CommunityMember[] {
    return this.getAllMembers().filter(m => m.role === role);
  }

  isMember(userId: string): boolean {
    return this.members.has(userId) && !userId.startsWith('__banned__');
  }

  isBanned(userId: string): boolean {
    const banned = this.members.get(`__banned__${userId}`);
    return banned?.banned === true;
  }

  getPendingVouches(inviteeId: string): { received: number; required: number } {
    const vouches = this.pendingVouches.get(inviteeId);
    return {
      received: vouches?.size ?? 0,
      required: this.communityInfo.requiredVouches,
    };
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
      communityId: this.communityInfo.communityId,
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
