import { describe, it, expect, beforeEach } from 'vitest';
import { CommunityManager } from '../../src/core/community/CommunityManager';
import { PeerScoring } from '../../src/core/relay/PeerScoring';

describe('SocialReputation', () => {
  let mgr: CommunityManager;

  beforeEach(() => {
    mgr = CommunityManager.create('Test Community', 'owner1', 'Owner', {
      reportConfig: {
        requiredVotes: 2,
        approvalThreshold: 0.5,
        reportCooldownMs: 0,
      },
      governanceConfig: {
        proposalCreatorRole: 'admin',
        defaultVoterRole: 'member',
        defaultVotingDurationMs: 60 * 60 * 1000,
        defaultQuorumThreshold: 0.1,
        defaultApprovalThreshold: 0.5,
        maxActiveProposals: 10,
      },
    });

    // Add members
    mgr.joinCommunity('admin1', 'Admin');
    mgr.changeRole('owner1', 'admin1', 'admin');
    mgr.joinCommunity('mod1', 'Mod1');
    mgr.changeRole('owner1', 'mod1', 'moderator');
    mgr.joinCommunity('mod2', 'Mod2');
    mgr.changeRole('owner1', 'mod2', 'moderator');
    mgr.joinCommunity('user1', 'User1');
    mgr.joinCommunity('user2', 'User2');
  });

  // ── Basic Social Score ────────────────────────────────────────────

  it('computes neutral score for new user', () => {
    const score = mgr.reputation.getSocialScore('user1');
    expect(score.socialScore).toBe(0);
    expect(score.reportCount).toBe(0);
    expect(score.governanceParticipation).toBe(0);
  });

  it('decreases score after confirmed report', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'warn');

    const score = mgr.reputation.recompute('user2');
    expect(score.confirmedReportCount).toBe(1);
    expect(score.socialScore).toBeLessThan(0);
  });

  it('increases score for governance participation', () => {
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('user1', proposal.proposalId, true);
    mgr.governance.finalizeProposal(proposal.proposalId);

    const score = mgr.reputation.recompute('user1');
    expect(score.governanceParticipation).toBeGreaterThan(0);
    expect(score.socialScore).toBeGreaterThan(0);
  });

  it('credits helpful report filings', () => {
    const report = mgr.fileReport('user1', 'user2', 'harassment', 'Bad behavior');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'kick');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'kick');

    const score = mgr.reputation.recompute('user1');
    expect(score.helpfulReportCount).toBe(1);
    expect(score.socialScore).toBeGreaterThan(0);
  });

  // ── Dual-Layer Combined Score ─────────────────────────────────────

  it('returns combined score without PeerScoring', () => {
    const combined = mgr.getUserReputation('user1');
    expect(combined.networkScore).toBe(0); // no PeerScoring connected
    expect(combined.socialScore).toBe(0);
    expect(combined.combinedScore).toBe(0);
  });

  it('integrates PeerScoring for combined score', () => {
    const peerScoring = new PeerScoring();
    mgr.setPeerScoring(peerScoring);

    peerScoring.addPeer('user1');
    // Boost network score
    for (let i = 0; i < 20; i++) {
      peerScoring.recordDelivery('user1');
    }

    const combined = mgr.getUserReputation('user1');
    expect(combined.networkScore).toBeGreaterThan(0);
    expect(combined.combinedScore).toBeGreaterThan(0);
  });

  it('penalizes user with both bad network and social scores', () => {
    const peerScoring = new PeerScoring();
    mgr.setPeerScoring(peerScoring);

    peerScoring.addPeer('user2');
    // Tank network score with invalid messages
    for (let i = 0; i < 10; i++) {
      peerScoring.recordInvalidMessage('user2');
    }

    // File a confirmed report
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'warn');

    const combined = mgr.getUserReputation('user2');
    expect(combined.networkScore).toBeLessThan(0);
    expect(combined.socialScore).toBeLessThan(0);
    expect(combined.combinedScore).toBeLessThan(0);
  });

  // ── Rankings ──────────────────────────────────────────────────────

  it('ranks users by combined score', () => {
    // Give user1 a positive social score via governance participation
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('user1', proposal.proposalId, true);
    mgr.governance.finalizeProposal(proposal.proposalId);

    const ranked = mgr.reputation.getRankedUsers(['user1', 'user2']);
    expect(ranked[0]!.userId).toBe('user1');
    expect(ranked[0]!.combinedScore).toBeGreaterThan(ranked[1]!.combinedScore);
  });

  // ── Good Standing ─────────────────────────────────────────────────

  it('reports good standing for clean user', () => {
    // Give user1 some positive reputation
    const proposal = mgr.createProposal('admin1', 'Test', 'Desc', 'custom');
    mgr.castGovernanceVote('user1', proposal.proposalId, true);
    mgr.governance.finalizeProposal(proposal.proposalId);

    expect(mgr.reputation.isInGoodStanding('user1')).toBe(true);
  });

  it('reports bad standing for penalized user', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'warn');

    expect(mgr.reputation.isInGoodStanding('user2')).toBe(false);
  });

  // ── Score Clamping ────────────────────────────────────────────────

  it('clamps social score to [-100, 100]', () => {
    // File many confirmed reports to try to go below -100
    for (let i = 0; i < 10; i++) {
      mgr.joinCommunity(`reporter${i}`, `Reporter${i}`);
      const report = mgr.fileReport(`reporter${i}`, 'user2', 'spam', `Report ${i}`);
      mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
      mgr.castReportVote('mod2', report.reportId, 'approve', 'warn');
    }

    const score = mgr.reputation.recompute('user2');
    expect(score.socialScore).toBeGreaterThanOrEqual(-100);
  });

  // ── Recompute All ─────────────────────────────────────────────────

  it('recomputes all tracked users', () => {
    mgr.reputation.recompute('user1');
    mgr.reputation.recompute('user2');
    mgr.reputation.recomputeAll();

    expect(mgr.reputation.getRawScore('user1')).toBeTruthy();
    expect(mgr.reputation.getRawScore('user2')).toBeTruthy();
  });
});
