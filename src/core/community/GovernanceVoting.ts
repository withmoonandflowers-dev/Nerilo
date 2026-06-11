/**
 * GovernanceVoting — Decentralized Community Decision Making
 *
 * Enables community-wide proposals and voting for governance decisions.
 * Proposals are recorded on the SharedLedgerEngine for transparency
 * and auditability.
 *
 * Flow:
 *   1. Eligible member creates a proposal (admin+ by default)
 *   2. Eligible members vote within the deadline
 *   3. After deadline or when quorum + threshold met, proposal resolves
 *   4. Results are recorded on the ledger
 *
 * Voting is transparent: all votes are public (no secret ballot).
 */

import { generateUUID } from '../../utils/uuid';
import { logger } from '../../utils/logger';
import type {
  CommunityRole,
  CommunityEvent,
  Proposal,
  ProposalType,
  ProposalStatus,
  GovernanceVote,
  ProposalResult,
} from './types';
import { ROLE_WEIGHT } from './types';
import type { RolePermissionManager } from './RolePermissionManager';
import type { MembershipService } from './MembershipService';

/** Configuration for governance voting */
export interface GovernanceConfig {
  /** Default voting duration in ms (default: 48 hours) */
  defaultVotingDurationMs: number;
  /** Default quorum threshold (default: 0.3 = 30% participation) */
  defaultQuorumThreshold: number;
  /** Default approval threshold (default: 0.5 = simple majority) */
  defaultApprovalThreshold: number;
  /** Minimum role to create proposals */
  proposalCreatorRole: CommunityRole;
  /** Minimum role to vote on proposals */
  defaultVoterRole: CommunityRole;
  /** Maximum active proposals at once */
  maxActiveProposals: number;
}

const DEFAULT_CONFIG: GovernanceConfig = {
  defaultVotingDurationMs: 48 * 60 * 60 * 1000, // 48 hours
  defaultQuorumThreshold: 0.3,
  defaultApprovalThreshold: 0.5,
  proposalCreatorRole: 'admin',
  defaultVoterRole: 'member',
  maxActiveProposals: 10,
};

export class GovernanceVoting {
  private proposals = new Map<string, Proposal>();
  private votes = new Map<string, GovernanceVote[]>(); // proposalId → votes
  private results = new Map<string, ProposalResult>();
  private eventListeners = new Set<(event: CommunityEvent) => void>();
  private config: GovernanceConfig;
  private communityId: string;
  private membership: MembershipService;

  constructor(
    communityId: string,
    _permissions: RolePermissionManager,
    membership: MembershipService,
    config: Partial<GovernanceConfig> = {}
  ) {
    this.communityId = communityId;
    this.membership = membership;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Creating Proposals ──────────────────────────────────────────────────

  /**
   * Create a new governance proposal.
   */
  createProposal(
    proposerId: string,
    title: string,
    description: string,
    type: ProposalType,
    payload: Record<string, unknown> = {},
    options: {
      durationMs?: number;
      quorumThreshold?: number;
      approvalThreshold?: number;
      eligibleRole?: CommunityRole;
    } = {}
  ): Proposal {
    const proposer = this.membership.getMemberOrThrow(proposerId);

    // Check proposal creation permission
    if (ROLE_WEIGHT[proposer.role] < ROLE_WEIGHT[this.config.proposalCreatorRole]) {
      throw new Error(
        `Creating proposals requires role "${this.config.proposalCreatorRole}" or higher`
      );
    }

    // Check active proposal limit
    const activeCount = this.getActiveProposals().length;
    if (activeCount >= this.config.maxActiveProposals) {
      throw new Error(
        `Maximum active proposals (${this.config.maxActiveProposals}) reached`
      );
    }

    if (!title.trim()) {
      throw new Error('Proposal title cannot be empty');
    }

    const now = Date.now();
    const proposal: Proposal = {
      proposalId: generateUUID(),
      communityId: this.communityId,
      proposerId,
      title: title.trim(),
      description: description.trim(),
      type,
      payload,
      status: 'active',
      createdAt: now,
      expiresAt: now + (options.durationMs ?? this.config.defaultVotingDurationMs),
      quorumThreshold: options.quorumThreshold ?? this.config.defaultQuorumThreshold,
      approvalThreshold: options.approvalThreshold ?? this.config.defaultApprovalThreshold,
      eligibleRole: options.eligibleRole ?? this.config.defaultVoterRole,
    };

    this.proposals.set(proposal.proposalId, proposal);
    this.votes.set(proposal.proposalId, []);

    this.emit('proposal:created', proposerId, undefined, {
      proposalId: proposal.proposalId,
      title: proposal.title,
      type: proposal.type,
      expiresAt: proposal.expiresAt,
    });

    logger.info('[GovernanceVoting] Proposal created', {
      proposalId: proposal.proposalId,
      title: proposal.title,
      type: proposal.type,
    });

    return proposal;
  }

  // ── Voting ──────────────────────────────────────────────────────────────

  /**
   * Cast a vote on an active proposal.
   * Returns ProposalResult if the vote triggers resolution (early resolution).
   */
  castVote(
    voterId: string,
    proposalId: string,
    approve: boolean
  ): ProposalResult | null {
    const voter = this.membership.getMemberOrThrow(voterId);
    const proposal = this.getProposalOrThrow(proposalId);

    // Check proposal is active
    if (proposal.status !== 'active') {
      throw new Error(`Proposal is ${proposal.status}, cannot vote`);
    }

    // Check expiry
    if (this.isExpired(proposal)) {
      return this.finalizeProposal(proposalId);
    }

    // Check voter eligibility
    if (ROLE_WEIGHT[voter.role] < ROLE_WEIGHT[proposal.eligibleRole]) {
      throw new Error(
        `Voting requires role "${proposal.eligibleRole}" or higher`
      );
    }

    // Check for duplicate vote
    const existingVotes = this.votes.get(proposalId) ?? [];
    if (existingVotes.some(v => v.voterId === voterId)) {
      throw new Error('Already voted on this proposal');
    }

    const vote: GovernanceVote = {
      voterId,
      proposalId,
      approve,
      votedAt: Date.now(),
    };

    existingVotes.push(vote);
    this.votes.set(proposalId, existingVotes);

    this.emit('proposal:vote-cast', voterId, undefined, {
      proposalId,
      approve,
      currentVotes: existingVotes.length,
    });

    // Check for early resolution (everyone eligible has voted)
    const totalEligible = this.getEligibleVoterCount(proposal);
    if (existingVotes.length >= totalEligible) {
      return this.finalizeProposal(proposalId);
    }

    return null;
  }

  // ── Resolution ──────────────────────────────────────────────────────────

  /**
   * Finalize a proposal — called when expired or all eligible voters have voted.
   * Can be called manually to check and resolve expired proposals.
   */
  finalizeProposal(proposalId: string): ProposalResult {
    const proposal = this.getProposalOrThrow(proposalId);

    // If already resolved, return cached result
    const cached = this.results.get(proposalId);
    if (cached) return cached;

    if (proposal.status !== 'active') {
      throw new Error(`Proposal is already ${proposal.status}`);
    }

    const votes = this.votes.get(proposalId) ?? [];
    const totalEligible = this.getEligibleVoterCount(proposal);
    const approveCount = votes.filter(v => v.approve).length;
    const rejectCount = votes.filter(v => !v.approve).length;

    // Check quorum
    const participationRate = totalEligible > 0 ? votes.length / totalEligible : 0;
    const quorumMet = participationRate >= proposal.quorumThreshold;

    // Determine outcome
    let status: 'passed' | 'rejected' | 'expired';
    if (!quorumMet) {
      status = this.isExpired(proposal) ? 'expired' : 'rejected';
    } else {
      const approvalRate = votes.length > 0 ? approveCount / votes.length : 0;
      status = approvalRate >= proposal.approvalThreshold ? 'passed' : 'rejected';
    }

    // If proposal hasn't expired yet and quorum not met, check if it can still pass
    if (!this.isExpired(proposal) && !quorumMet && votes.length < totalEligible) {
      // Not yet expired and not everyone voted — only finalize if everyone voted
      status = 'rejected';
    }

    const result: ProposalResult = {
      proposalId,
      status,
      approveCount,
      rejectCount,
      totalEligible,
      quorumMet,
      resolvedAt: Date.now(),
    };

    proposal.status = status;
    this.results.set(proposalId, result);

    this.emit('proposal:resolved', proposal.proposerId, undefined, {
      proposalId,
      status,
      approveCount,
      rejectCount,
      totalEligible,
      quorumMet,
    });

    logger.info('[GovernanceVoting] Proposal resolved', {
      proposalId,
      status,
      approveCount,
      rejectCount,
      quorumMet,
    });

    return result;
  }

  /**
   * Cancel an active proposal (only proposer or admin+ can cancel).
   */
  cancelProposal(actorId: string, proposalId: string): void {
    const actor = this.membership.getMemberOrThrow(actorId);
    const proposal = this.getProposalOrThrow(proposalId);

    if (proposal.status !== 'active') {
      throw new Error(`Proposal is already ${proposal.status}`);
    }

    // Only proposer or admin+ can cancel
    if (actorId !== proposal.proposerId && ROLE_WEIGHT[actor.role] < ROLE_WEIGHT['admin']) {
      throw new Error('Only the proposer or an admin can cancel a proposal');
    }

    proposal.status = 'cancelled';

    logger.info('[GovernanceVoting] Proposal cancelled', {
      proposalId,
      cancelledBy: actorId,
    });
  }

  /**
   * Check and finalize all expired proposals.
   */
  finalizeExpired(): ProposalResult[] {
    const results: ProposalResult[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.status === 'active' && this.isExpired(proposal)) {
        results.push(this.finalizeProposal(proposal.proposalId));
      }
    }
    return results;
  }

  // ── Ledger Integration ──────────────────────────────────────────────────

  /**
   * Serialize a proposal and its result for ledger recording.
   */
  toLedgerPayload(proposalId: string): Record<string, unknown> {
    const proposal = this.proposals.get(proposalId);
    const votes = this.votes.get(proposalId) ?? [];
    const result = this.results.get(proposalId);

    return {
      type: 'governance:proposal',
      proposal: proposal ? { ...proposal } : null,
      votes: votes.map(v => ({ ...v })),
      result: result ? { ...result } : null,
    };
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  getProposal(proposalId: string): Proposal | undefined {
    return this.proposals.get(proposalId);
  }

  getProposalOrThrow(proposalId: string): Proposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found`);
    return proposal;
  }

  getActiveProposals(): Proposal[] {
    return [...this.proposals.values()].filter(p => p.status === 'active');
  }

  getProposalsByStatus(status: ProposalStatus): Proposal[] {
    return [...this.proposals.values()].filter(p => p.status === status);
  }

  getVotesForProposal(proposalId: string): GovernanceVote[] {
    return [...(this.votes.get(proposalId) ?? [])];
  }

  getResult(proposalId: string): ProposalResult | undefined {
    return this.results.get(proposalId);
  }

  getEligibleVoterCount(proposal: Proposal): number {
    const allMembers = this.membership.getAllMembers();
    return allMembers.filter(
      m => ROLE_WEIGHT[m.role] >= ROLE_WEIGHT[proposal.eligibleRole]
    ).length;
  }

  /** Get governance participation stats for a user */
  getUserParticipation(userId: string): {
    proposalsCreated: number;
    votescast: number;
    eligibleProposals: number;
  } {
    let proposalsCreated = 0;
    let votesCast = 0;
    let eligibleProposals = 0;

    const member = this.membership.getMember(userId);
    if (!member) return { proposalsCreated: 0, votescast: 0, eligibleProposals: 0 };

    for (const proposal of this.proposals.values()) {
      if (proposal.proposerId === userId) proposalsCreated++;
      if (ROLE_WEIGHT[member.role] >= ROLE_WEIGHT[proposal.eligibleRole]) {
        eligibleProposals++;
      }
    }

    for (const votes of this.votes.values()) {
      if (votes.some(v => v.voterId === userId)) votesCast++;
    }

    return { proposalsCreated, votescast: votesCast, eligibleProposals };
  }

  private isExpired(proposal: Proposal): boolean {
    return Date.now() >= proposal.expiresAt;
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
