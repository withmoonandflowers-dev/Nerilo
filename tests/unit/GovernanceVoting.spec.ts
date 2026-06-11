import { describe, it, expect, beforeEach } from 'vitest';
import { CommunityManager } from '../../src/core/community/CommunityManager';
import type { CommunityEvent } from '../../src/core/community/types';

describe('GovernanceVoting', () => {
  let mgr: CommunityManager;
  let events: CommunityEvent[];

  beforeEach(() => {
    mgr = CommunityManager.create('Test Community', 'owner1', 'Owner', {
      governanceConfig: {
        defaultVotingDurationMs: 60 * 60 * 1000, // 1 hour
        defaultQuorumThreshold: 0.3,
        defaultApprovalThreshold: 0.5,
        proposalCreatorRole: 'admin',
        defaultVoterRole: 'member',
        maxActiveProposals: 5,
      },
    });
    events = [];
    mgr.onEvent((e) => events.push(e));

    // Add members
    mgr.joinCommunity('admin1', 'Admin');
    mgr.changeRole('owner1', 'admin1', 'admin');
    mgr.joinCommunity('mod1', 'Mod1');
    mgr.changeRole('owner1', 'mod1', 'moderator');
    mgr.joinCommunity('user1', 'User1');
    mgr.joinCommunity('user2', 'User2');
    mgr.joinCommunity('user3', 'User3');
    events.length = 0;
  });

  // ── Creating Proposals ────────────────────────────────────────────

  it('allows admin to create a proposal', () => {
    const proposal = mgr.createProposal(
      'admin1', 'New Rule', 'Add greeting rule', 'rule-change'
    );
    expect(proposal.proposalId).toBeTruthy();
    expect(proposal.title).toBe('New Rule');
    expect(proposal.status).toBe('active');
    expect(proposal.proposerId).toBe('admin1');
  });

  it('allows owner to create a proposal', () => {
    const proposal = mgr.createProposal(
      'owner1', 'Change Setting', 'Desc', 'community-setting'
    );
    expect(proposal.status).toBe('active');
  });

  it('rejects proposal from regular member', () => {
    expect(() => mgr.createProposal('user1', 'Idea', 'Desc', 'custom'))
      .toThrow(/requires role/);
  });

  it('rejects empty title', () => {
    expect(() => mgr.createProposal('admin1', '  ', 'Desc', 'custom'))
      .toThrow('Proposal title cannot be empty');
  });

  it('enforces max active proposals', () => {
    for (let i = 0; i < 5; i++) {
      mgr.createProposal('admin1', `Proposal ${i}`, 'Desc', 'custom');
    }
    expect(() => mgr.createProposal('admin1', 'One too many', 'Desc', 'custom'))
      .toThrow(/Maximum active proposals/);
  });

  it('emits proposal:created event', () => {
    mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    const evt = events.find(e => e.type === 'proposal:created');
    expect(evt).toBeTruthy();
    expect(evt!.data!.title).toBe('Test');
  });

  // ── Voting ────────────────────────────────────────────────────────

  it('allows members to vote on proposals', () => {
    const proposal = mgr.createProposal('admin1', 'Vote Test', 'Desc', 'custom');
    const result = mgr.castGovernanceVote('user1', proposal.proposalId, true);
    expect(result).toBeNull(); // not all have voted

    const votes = mgr.governance.getVotesForProposal(proposal.proposalId);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.approve).toBe(true);
  });

  it('rejects vote from guest (below eligible role)', () => {
    mgr.joinCommunity('guest1', 'Guest');
    mgr.changeRole('owner1', 'guest1', 'guest');

    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    expect(() => mgr.castGovernanceVote('guest1', proposal.proposalId, true))
      .toThrow(/requires role/);
  });

  it('rejects duplicate vote', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('user1', proposal.proposalId, true);
    expect(() => mgr.castGovernanceVote('user1', proposal.proposalId, false))
      .toThrow('Already voted');
  });

  it('emits proposal:vote-cast event', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    events.length = 0;
    mgr.castGovernanceVote('user1', proposal.proposalId, true);
    const evt = events.find(e => e.type === 'proposal:vote-cast');
    expect(evt).toBeTruthy();
    expect(evt!.data!.approve).toBe(true);
  });

  // ── Resolution ────────────────────────────────────────────────────

  it('resolves when all eligible voters have voted (passed)', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    // 6 eligible members: owner1, admin1, mod1, user1, user2, user3
    mgr.castGovernanceVote('owner1', proposal.proposalId, true);
    mgr.castGovernanceVote('admin1', proposal.proposalId, true);
    mgr.castGovernanceVote('mod1', proposal.proposalId, true);
    mgr.castGovernanceVote('user1', proposal.proposalId, true);
    mgr.castGovernanceVote('user2', proposal.proposalId, false);
    const result = mgr.castGovernanceVote('user3', proposal.proposalId, false);

    expect(result).toBeTruthy();
    expect(result!.status).toBe('passed');
    expect(result!.approveCount).toBe(4);
    expect(result!.rejectCount).toBe(2);
    expect(result!.quorumMet).toBe(true);
  });

  it('rejects when majority votes against', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('owner1', proposal.proposalId, false);
    mgr.castGovernanceVote('admin1', proposal.proposalId, false);
    mgr.castGovernanceVote('mod1', proposal.proposalId, false);
    mgr.castGovernanceVote('user1', proposal.proposalId, false);
    mgr.castGovernanceVote('user2', proposal.proposalId, true);
    const result = mgr.castGovernanceVote('user3', proposal.proposalId, true);

    expect(result).toBeTruthy();
    expect(result!.status).toBe('rejected');
    expect(result!.quorumMet).toBe(true);
  });

  it('handles manual finalization', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('owner1', proposal.proposalId, true);
    mgr.castGovernanceVote('admin1', proposal.proposalId, true);
    // Only 2/6 voted = 33% participation

    const result = mgr.governance.finalizeProposal(proposal.proposalId);
    expect(result).toBeTruthy();
    // 2/6 = 33% participation >= 30% quorum, 2/2 = 100% approval
    expect(result.quorumMet).toBe(true);
    expect(result.status).toBe('passed');
  });

  it('rejects proposal that fails quorum', () => {
    const proposal = mgr.governance.createProposal('admin1', 'Test', 'Desc', 'custom', {}, {
      quorumThreshold: 0.5,
    });
    // Only 1/6 voted = 16.7% participation < 50% quorum
    mgr.castGovernanceVote('user1', proposal.proposalId, true);

    const result = mgr.governance.finalizeProposal(proposal.proposalId);
    expect(result.quorumMet).toBe(false);
    expect(result.status).toBe('rejected');
  });

  it('emits proposal:resolved event', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('owner1', proposal.proposalId, true);
    events.length = 0;
    mgr.governance.finalizeProposal(proposal.proposalId);

    const evt = events.find(e => e.type === 'proposal:resolved');
    expect(evt).toBeTruthy();
  });

  // ── Cancellation ──────────────────────────────────────────────────

  it('allows proposer to cancel', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.governance.cancelProposal('admin1', proposal.proposalId);
    expect(mgr.governance.getProposal(proposal.proposalId)!.status).toBe('cancelled');
  });

  it('allows admin to cancel others proposal', () => {
    const proposal = mgr.createProposal('owner1', 'Test', 'Desc', 'custom');
    mgr.governance.cancelProposal('admin1', proposal.proposalId);
    expect(mgr.governance.getProposal(proposal.proposalId)!.status).toBe('cancelled');
  });

  it('rejects cancel from regular member (not proposer)', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    expect(() => mgr.governance.cancelProposal('user1', proposal.proposalId))
      .toThrow('Only the proposer or an admin');
  });

  // ── Expired Proposals ─────────────────────────────────────────────

  it('finalizes expired proposals', async () => {
    mgr.governance.createProposal('admin1', 'Test', 'Desc', 'custom', {}, {
      durationMs: 1, // expires immediately
    });

    await new Promise(r => setTimeout(r, 10));
    const results = mgr.governance.finalizeExpired();
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('expired');
  });

  // ── Ledger Payload ────────────────────────────────────────────────

  it('produces ledger-ready payload', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('user1', proposal.proposalId, true);

    const payload = mgr.governance.toLedgerPayload(proposal.proposalId);
    expect(payload.type).toBe('governance:proposal');
    expect(payload.proposal).toBeTruthy();
    expect(payload.votes).toHaveLength(1);
  });

  // ── Queries ───────────────────────────────────────────────────────

  it('returns active proposals', () => {
    mgr.createProposal('admin1', 'A', 'D', 'custom');
    mgr.createProposal('admin1', 'B', 'D', 'custom');
    expect(mgr.governance.getActiveProposals()).toHaveLength(2);
  });

  it('returns user participation stats', () => {
    const p1 = mgr.createProposal('admin1', 'A', 'D', 'custom');
    mgr.createProposal('admin1', 'B', 'D', 'custom');
    mgr.castGovernanceVote('user1', p1.proposalId, true);

    const stats = mgr.governance.getUserParticipation('user1');
    expect(stats.proposalsCreated).toBe(0);
    expect(stats.votescast).toBe(1);
    expect(stats.eligibleProposals).toBe(2);
  });

  it('rejects voting on non-active proposal', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.governance.cancelProposal('admin1', proposal.proposalId);
    expect(() => mgr.castGovernanceVote('user1', proposal.proposalId, true))
      .toThrow(/cancelled/);
  });
});
