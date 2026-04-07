/**
 * Community Layer — Type Definitions
 *
 * Provides organizational structure on top of the existing
 * mesh/relay/crypto infrastructure. A Community contains
 * Channels (each backed by a MeshGossipManager room),
 * Members with Roles, and governance primitives.
 */

// ── Roles & Permissions ────────────────────────────────────────────────────

/** Role hierarchy: owner > admin > moderator > member > guest */
export type CommunityRole = 'owner' | 'admin' | 'moderator' | 'member' | 'guest';

/** Numeric weight for role comparison (higher = more authority) */
export const ROLE_WEIGHT: Record<CommunityRole, number> = {
  owner: 100,
  admin: 80,
  moderator: 60,
  member: 40,
  guest: 20,
};

/** Actions that can be gated by permissions */
export type PermissionAction =
  | 'channel:create'
  | 'channel:delete'
  | 'channel:rename'
  | 'member:invite'
  | 'member:kick'
  | 'member:ban'
  | 'member:change-role'
  | 'message:send'
  | 'message:delete-others'
  | 'announcement:create'
  | 'community:edit-info'
  | 'community:delete';

/** Minimum role required for each action (configurable per community) */
export type PermissionPolicy = Record<PermissionAction, CommunityRole>;

/** Default permission policy */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  'channel:create': 'admin',
  'channel:delete': 'admin',
  'channel:rename': 'moderator',
  'member:invite': 'member',
  'member:kick': 'moderator',
  'member:ban': 'admin',
  'member:change-role': 'admin',
  'message:send': 'guest',
  'message:delete-others': 'moderator',
  'announcement:create': 'moderator',
  'community:edit-info': 'admin',
  'community:delete': 'owner',
};

// ── Member ─────────────────────────────────────────────────────────────────

export interface CommunityMember {
  /** Firebase UID or ECDSA-derived identity */
  userId: string;
  /** Display name */
  displayName: string;
  /** Role within this community */
  role: CommunityRole;
  /** Timestamp of joining */
  joinedAt: number;
  /** Who invited this member (userId), null for founders */
  invitedBy: string | null;
  /** Whether the member is currently banned */
  banned: boolean;
}

// ── Channel ────────────────────────────────────────────────────────────────

export type ChannelType = 'text' | 'announcement' | 'voice';

export interface ChannelInfo {
  /** Unique channel identifier */
  channelId: string;
  /** Human-readable channel name */
  name: string;
  /** Optional description */
  description: string;
  /** Channel type */
  type: ChannelType;
  /** Room ID backing this channel (used by MeshGossipManager) */
  roomId: string;
  /** Who created the channel */
  createdBy: string;
  /** Creation timestamp */
  createdAt: number;
  /** Whether the channel is archived (read-only) */
  archived: boolean;
}

// ── Community ──────────────────────────────────────────────────────────────

export interface CommunityInfo {
  /** Unique community identifier */
  communityId: string;
  /** Community display name */
  name: string;
  /** Optional description */
  description: string;
  /** Community owner userId */
  ownerId: string;
  /** Creation timestamp */
  createdAt: number;
  /** Invite-only or open join */
  joinPolicy: 'open' | 'invite-only';
  /** Minimum vouches required for invite-only (Sybil resistance) */
  requiredVouches: number;
  /** Custom permission overrides (merged with DEFAULT_PERMISSION_POLICY) */
  permissionOverrides: Partial<PermissionPolicy>;
}

// ── Events ─────────────────────────────────────────────────────────────────

export type CommunityEventType =
  | 'member:joined'
  | 'member:left'
  | 'member:kicked'
  | 'member:banned'
  | 'member:role-changed'
  | 'channel:created'
  | 'channel:deleted'
  | 'channel:archived'
  | 'community:info-updated';

export interface CommunityEvent {
  type: CommunityEventType;
  communityId: string;
  actorId: string;
  targetId?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}
