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
  | 'community:info-updated'
  | 'report:created'
  | 'report:vote-cast'
  | 'report:resolved'
  | 'proposal:created'
  | 'proposal:vote-cast'
  | 'proposal:resolved';

export interface CommunityEvent {
  type: CommunityEventType;
  communityId: string;
  actorId: string;
  targetId?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ── Report System ─────────────────────────────────────────────────────────

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate-speech'
  | 'inappropriate-content'
  | 'impersonation'
  | 'other';

export type ReportStatus = 'pending' | 'under-review' | 'resolved' | 'dismissed';

export type ReportAction = 'warn' | 'mute' | 'kick' | 'ban' | 'dismiss';

export interface Report {
  reportId: string;
  communityId: string;
  /** User being reported */
  targetId: string;
  /** User who filed the report */
  reporterId: string;
  reason: ReportReason;
  description: string;
  /** Evidence: message IDs, screenshots, etc. */
  evidence: string[];
  status: ReportStatus;
  createdAt: number;
  resolvedAt: number | null;
  /** Final action taken (set on resolution) */
  resolvedAction: ReportAction | null;
}

export type VoteDecision = 'approve' | 'reject';

export interface ModeratorVote {
  moderatorId: string;
  reportId: string;
  /** Proposed action if approving */
  proposedAction: ReportAction;
  decision: VoteDecision;
  reason: string;
  votedAt: number;
}

export interface ReportResolution {
  reportId: string;
  action: ReportAction;
  /** Votes that led to this resolution */
  votes: ModeratorVote[];
  /** Total eligible voters at resolution time */
  totalEligibleVoters: number;
  resolvedAt: number;
}

// ── Governance Voting ─────────────────────────────────────────────────────

export type ProposalType =
  | 'rule-change'
  | 'permission-change'
  | 'role-assignment'
  | 'channel-action'
  | 'community-setting'
  | 'custom';

export type ProposalStatus = 'active' | 'passed' | 'rejected' | 'expired' | 'cancelled';

export interface Proposal {
  proposalId: string;
  communityId: string;
  /** Who created the proposal */
  proposerId: string;
  title: string;
  description: string;
  type: ProposalType;
  /** Machine-readable payload for auto-execution */
  payload: Record<string, unknown>;
  status: ProposalStatus;
  createdAt: number;
  /** Voting deadline (epoch ms) */
  expiresAt: number;
  /** Minimum participation rate (0-1) required for quorum */
  quorumThreshold: number;
  /** Approval rate (0-1) required to pass (of those who voted) */
  approvalThreshold: number;
  /** Minimum role required to vote */
  eligibleRole: CommunityRole;
}

export interface GovernanceVote {
  voterId: string;
  proposalId: string;
  /** true = approve, false = reject */
  approve: boolean;
  votedAt: number;
}

export interface ProposalResult {
  proposalId: string;
  status: 'passed' | 'rejected' | 'expired';
  approveCount: number;
  rejectCount: number;
  totalEligible: number;
  quorumMet: boolean;
  resolvedAt: number;
}

// ── Social Reputation ─────────────────────────────────────────────────────

export interface SocialReputationScore {
  userId: string;
  /** Reports filed against this user (higher = worse) */
  reportCount: number;
  /** Reports confirmed (action taken) against this user */
  confirmedReportCount: number;
  /** Governance participation rate (proposals voted / eligible proposals) */
  governanceParticipation: number;
  /** Helpful votes received on reports filed by this user */
  helpfulReportCount: number;
  /** Composite social reputation (-100 to +100) */
  socialScore: number;
  lastUpdated: number;
}
