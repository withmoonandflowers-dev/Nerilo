/**
 * ReportSystem — Decentralized Report & Moderator Voting
 *
 * Allows community members to report misbehavior. Reports are
 * reviewed by moderators through a voting mechanism:
 *   - Any member can file a report
 *   - Moderators+ can cast votes on pending reports
 *   - Resolution requires a configurable vote threshold (default: 3/5)
 *   - Actions: warn, mute, kick, ban, dismiss
 *
 * Integrates with MembershipService for executing actions
 * and emits events for ledger recording.
 */

import { generateUUID } from '../../utils/uuid';
import { logger } from '../../utils/logger';
import type {
  CommunityRole,
  CommunityEvent,
  Report,
  ReportReason,
  ReportAction,
  ReportStatus,
  ModeratorVote,
  VoteDecision,
  ReportResolution,
} from './types';
import { ROLE_WEIGHT } from './types';
import type { RolePermissionManager } from './RolePermissionManager';
import type { MembershipService } from './MembershipService';

/** Configuration for report voting */
export interface ReportVotingConfig {
  /** Minimum number of votes required to resolve a report (default: 3) */
  requiredVotes: number;
  /** Fraction of approvals needed among votes to take action (default: 0.6 = 3/5) */
  approvalThreshold: number;
  /** Auto-expire reports after this many ms (default: 7 days) */
  reportTTLMs: number;
  /** Minimum role to cast a moderation vote */
  votingRole: CommunityRole;
  /** Cooldown between reports from the same reporter against the same target (ms) */
  reportCooldownMs: number;
}

const DEFAULT_CONFIG: ReportVotingConfig = {
  requiredVotes: 3,
  approvalThreshold: 0.6,
  reportTTLMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  votingRole: 'moderator',
  reportCooldownMs: 60 * 60 * 1000, // 1 hour
};

export class ReportSystem {
  private reports = new Map<string, Report>();
  private votes = new Map<string, ModeratorVote[]>(); // reportId → votes
  private resolutions = new Map<string, ReportResolution>();
  private eventListeners = new Set<(event: CommunityEvent) => void>();
  private config: ReportVotingConfig;
  private communityId: string;
  private membership: MembershipService;

  constructor(
    communityId: string,
    _permissions: RolePermissionManager,
    membership: MembershipService,
    config: Partial<ReportVotingConfig> = {}
  ) {
    this.communityId = communityId;
    this.membership = membership;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Filing Reports ──────────────────────────────────────────────────────

  /**
   * File a report against a community member.
   * Any member can report; cannot report yourself.
   */
  fileReport(
    reporterId: string,
    targetId: string,
    reason: ReportReason,
    description: string,
    evidence: string[] = []
  ): Report {
    // Validate reporter is a member
    this.membership.getMemberOrThrow(reporterId);

    // Validate target is a member
    this.membership.getMemberOrThrow(targetId);

    // Cannot report yourself
    if (reporterId === targetId) {
      throw new Error('Cannot report yourself');
    }

    // Cooldown check: prevent spam reports
    this.enforceCooldown(reporterId, targetId);

    const report: Report = {
      reportId: generateUUID(),
      communityId: this.communityId,
      targetId,
      reporterId,
      reason,
      description,
      evidence,
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedAction: null,
    };

    this.reports.set(report.reportId, report);
    this.votes.set(report.reportId, []);

    this.emit('report:created', reporterId, targetId, {
      reportId: report.reportId,
      reason,
    });

    logger.info('[ReportSystem] Report filed', {
      reportId: report.reportId,
      reason,
    });

    return report;
  }

  // ── Moderator Voting ────────────────────────────────────────────────────

  /**
   * Cast a vote on a pending/under-review report.
   * Only eligible moderators (votingRole+) can vote.
   * Returns the resolution if voting threshold is met.
   */
  castVote(
    moderatorId: string,
    reportId: string,
    decision: VoteDecision,
    proposedAction: ReportAction,
    reason: string = ''
  ): ReportResolution | null {
    const moderator = this.membership.getMemberOrThrow(moderatorId);

    // Check voting eligibility
    if (ROLE_WEIGHT[moderator.role] < ROLE_WEIGHT[this.config.votingRole]) {
      throw new Error(
        `Voting requires role "${this.config.votingRole}" or higher`
      );
    }

    const report = this.getReportOrThrow(reportId);

    // Cannot vote on resolved/dismissed/expired reports
    if (report.status === 'resolved' || report.status === 'dismissed') {
      throw new Error('Cannot vote on a resolved report');
    }

    // Check TTL expiry
    if (this.isExpired(report)) {
      report.status = 'dismissed';
      throw new Error('Report has expired');
    }

    // Cannot vote on a report about yourself
    if (moderatorId === report.targetId) {
      throw new Error('Cannot vote on a report about yourself');
    }

    // Check for duplicate vote
    const existingVotes = this.votes.get(reportId) ?? [];
    if (existingVotes.some(v => v.moderatorId === moderatorId)) {
      throw new Error('Already voted on this report');
    }

    const vote: ModeratorVote = {
      moderatorId,
      reportId,
      proposedAction,
      decision,
      reason,
      votedAt: Date.now(),
    };

    existingVotes.push(vote);
    this.votes.set(reportId, existingVotes);

    // Move to under-review on first vote
    if (report.status === 'pending') {
      report.status = 'under-review';
    }

    this.emit('report:vote-cast', moderatorId, report.targetId, {
      reportId,
      decision,
      proposedAction,
      currentVotes: existingVotes.length,
      requiredVotes: this.config.requiredVotes,
    });

    // Check if enough votes to resolve
    if (existingVotes.length >= this.config.requiredVotes) {
      return this.resolveReport(reportId, existingVotes);
    }

    return null;
  }

  // ── Resolution ──────────────────────────────────────────────────────────

  /**
   * Resolve a report based on collected votes.
   * Uses majority decision; on tie, dismisses.
   * The most severe proposed action among approvals wins.
   */
  private resolveReport(
    reportId: string,
    votes: ModeratorVote[]
  ): ReportResolution {
    const report = this.getReportOrThrow(reportId);
    const approvals = votes.filter(v => v.decision === 'approve');
    const rejections = votes.filter(v => v.decision === 'reject');

    const approvalRate = approvals.length / votes.length;
    const shouldAct = approvalRate >= this.config.approvalThreshold;

    let action: ReportAction;
    if (shouldAct && approvals.length > 0) {
      // Pick the most common proposed action among approvals
      action = this.pickMajorityAction(approvals);
    } else {
      action = 'dismiss';
    }

    // Apply the action
    const totalEligible = this.getEligibleVoterCount();
    const resolution: ReportResolution = {
      reportId,
      action,
      votes: [...votes],
      totalEligibleVoters: totalEligible,
      resolvedAt: Date.now(),
    };

    report.status = action === 'dismiss' ? 'dismissed' : 'resolved';
    report.resolvedAt = resolution.resolvedAt;
    report.resolvedAction = action;
    this.resolutions.set(reportId, resolution);

    // Execute the action
    if (action !== 'dismiss' && action !== 'warn') {
      this.executeAction(report, action);
    }

    this.emit('report:resolved', report.reporterId, report.targetId, {
      reportId,
      action,
      approveCount: approvals.length,
      rejectCount: rejections.length,
    });

    logger.info('[ReportSystem] Report resolved', {
      reportId,
      action,
      approvals: approvals.length,
      rejections: rejections.length,
    });

    return resolution;
  }

  /**
   * Pick the most common proposed action; on tie, pick the more severe one.
   */
  private pickMajorityAction(approvals: ModeratorVote[]): ReportAction {
    const actionSeverity: Record<ReportAction, number> = {
      dismiss: 0,
      warn: 1,
      mute: 2,
      kick: 3,
      ban: 4,
    };

    const counts = new Map<ReportAction, number>();
    for (const v of approvals) {
      counts.set(v.proposedAction, (counts.get(v.proposedAction) ?? 0) + 1);
    }

    // Sort by count desc, then severity desc
    const sorted = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]; // more votes first
      return actionSeverity[b[0]] - actionSeverity[a[0]]; // more severe first
    });

    return sorted[0]![0];
  }

  /**
   * Execute a moderation action against the reported user.
   */
  private executeAction(report: Report, action: ReportAction): void {
    try {
      switch (action) {
        case 'kick':
          // Find any moderator+ to be the actor for the kick
          this.membership.kick(this.findActorForAction(), report.targetId);
          break;
        case 'ban':
          this.membership.ban(this.findActorForAction(), report.targetId);
          break;
        case 'mute':
          // Mute = change role to guest (restricted permissions)
          this.membership.changeRole(
            this.findActorForAction(),
            report.targetId,
            'guest'
          );
          break;
        default:
          break;
      }
    } catch (err) {
      logger.warn('[ReportSystem] Failed to execute action', {
        action,
        targetId: report.targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Find a suitable actor (owner or admin) for executing moderation actions.
   */
  private findActorForAction(): string {
    const owners = this.membership.getMembersByRole('owner');
    if (owners.length > 0) return owners[0]!.userId;

    const admins = this.membership.getMembersByRole('admin');
    if (admins.length > 0) return admins[0]!.userId;

    throw new Error('No eligible actor found to execute moderation action');
  }

  // ── Cooldown ────────────────────────────────────────────────────────────

  private enforceCooldown(reporterId: string, targetId: string): void {
    const now = Date.now();
    for (const report of this.reports.values()) {
      if (
        report.reporterId === reporterId &&
        report.targetId === targetId &&
        now - report.createdAt < this.config.reportCooldownMs
      ) {
        throw new Error(
          'Report cooldown active. Please wait before filing another report against this user.'
        );
      }
    }
  }

  private isExpired(report: Report): boolean {
    return Date.now() - report.createdAt > this.config.reportTTLMs;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  getReport(reportId: string): Report | undefined {
    return this.reports.get(reportId);
  }

  getReportOrThrow(reportId: string): Report {
    const report = this.reports.get(reportId);
    if (!report) throw new Error(`Report "${reportId}" not found`);
    return report;
  }

  getReportsByTarget(targetId: string): Report[] {
    return [...this.reports.values()].filter(r => r.targetId === targetId);
  }

  getReportsByStatus(status: ReportStatus): Report[] {
    return [...this.reports.values()].filter(r => r.status === status);
  }

  getPendingReports(): Report[] {
    return this.getReportsByStatus('pending')
      .concat(this.getReportsByStatus('under-review'))
      .filter(r => !this.isExpired(r));
  }

  getVotesForReport(reportId: string): ModeratorVote[] {
    return [...(this.votes.get(reportId) ?? [])];
  }

  getResolution(reportId: string): ReportResolution | undefined {
    return this.resolutions.get(reportId);
  }

  getEligibleVoterCount(): number {
    const allMembers = this.membership.getAllMembers();
    return allMembers.filter(
      m => ROLE_WEIGHT[m.role] >= ROLE_WEIGHT[this.config.votingRole]
    ).length;
  }

  /** Get report statistics for a user (used by Social Reputation) */
  getUserReportStats(userId: string): {
    reportsAgainst: number;
    confirmedReportsAgainst: number;
    reportsFiledThatHelped: number;
  } {
    let reportsAgainst = 0;
    let confirmedReportsAgainst = 0;
    let reportsFiledThatHelped = 0;

    for (const report of this.reports.values()) {
      if (report.targetId === userId) {
        reportsAgainst++;
        if (report.status === 'resolved' && report.resolvedAction !== 'dismiss') {
          confirmedReportsAgainst++;
        }
      }
      if (report.reporterId === userId && report.status === 'resolved' && report.resolvedAction !== 'dismiss') {
        reportsFiledThatHelped++;
      }
    }

    return { reportsAgainst, confirmedReportsAgainst, reportsFiledThatHelped };
  }

  /** Cleanup expired reports */
  pruneExpired(): number {
    let pruned = 0;
    for (const [_id, report] of this.reports) {
      if (this.isExpired(report) && (report.status === 'pending' || report.status === 'under-review')) {
        report.status = 'dismissed';
        pruned++;
      }
    }
    return pruned;
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
